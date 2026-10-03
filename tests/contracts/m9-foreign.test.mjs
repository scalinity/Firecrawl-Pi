import{test}from'node:test';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';
test('empty Compose labels do not turn owned disposable containers into foreign infrastructure',()=>{
 const rows='core\tfcpi\t\nfixture-pg\t\tincident-tests\nowner-app\t\t\nother-project\tother\t\n';
 const result=execFileSync('awk',['-F','\t','$2 != "fcpi" && $3 == "" {print $1}'],{input:rows,encoding:'utf8'}).trim().split('\n');
 assert.deepEqual(result,['owner-app','other-project']);
});
