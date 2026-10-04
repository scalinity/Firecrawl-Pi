import importlib.util
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('provision', Path(__file__).resolve().parents[2]/'scripts/hosted-mcp/pi-configure-openai.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
DATA = {'key': 'sk-' + 'synthetic-fixture_'*3, 'tunnel': 'tunnel_'+'a'*32}


class ProvisionTests(unittest.TestCase):
    def test_precise_bytes_modes_and_matching_rerun(self):
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(temporary)
            old_umask = os.umask(0o022)
            try:
                module.provision(p, DATA)
                module.provision(p, DATA)
            finally:
                os.umask(old_umask)
            self.assertEqual((p/'openai-runtime-key').read_bytes(), DATA['key'].encode()+b'\n')
            self.assertEqual((p/'openai-runtime-key').stat().st_mode & 0o777, 0o600)
            self.assertEqual((p/'openai.yaml').stat().st_mode & 0o777, 0o644)

    def test_interrupted_profile_is_resumable(self):
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(temporary)
            publish = module.publish
            def fail_profile(path, *args):
                if path.name == 'openai.yaml':
                    raise OSError('synthetic interruption')
                publish(path, *args)
            with patch.object(module, 'publish', fail_profile), self.assertRaises(OSError):
                module.provision(p, DATA)
            self.assertFalse((p/'openai.yaml').exists())
            module.provision(p, DATA)
            self.assertTrue((p/'openai.yaml').exists())

    def test_mismatch_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(temporary)
            (p/'openai.yaml').write_text('different configuration')
            with self.assertRaises(ValueError):
                module.provision(p, DATA)
            self.assertFalse((p/'openai-runtime-key').exists())
            (p/'openai.yaml').unlink()
            (p/'openai.yaml').symlink_to(p/'absent')
            with self.assertRaises(ValueError):
                module.provision(p, DATA)

    def test_secret_stage_private_during_failed_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(temporary)
            original = module.os.fdopen
            def fail(fd, *args):
                self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o600)
                os.close(fd)
                raise OSError('synthetic failure before write')
            with patch.object(module.os, 'fdopen', fail), self.assertRaises(OSError):
                module.publish(p/'key', 'synthetic', 0o600)
            self.assertEqual(list(p.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
