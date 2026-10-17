# Direct API probes, 2026-10-17 (transcribed)

These ran once from the workstation, against the Anthropic API directly, with the keys read from the ignored `.env` inside the process (no key on a command line or in output). They bypass the Pi, so their cost is **not** in the Pi's ledger and does not count against its caps. The text below is copied from the session's terminal output; it was not written to a file at the time. The scripts were run from the session scratchpad and are not retained. The post-fix schema battery is the one probe that is also saved as a raw file (`schema-battery-after-fix.txt`).

Approximate spend of everything on this page: **$0.23**, almost all of it the Opus throughput measurement.

## 1. Union-typed field limit (claude-haiku-5-5, thinking disabled, `max_tokens` 400)

A flat object of N properties, each `{type: ["string","null"]}`, all required:

```
haiku unions=5  -> HTTP 200 stop=end_turn model=claude-haiku-5-5 in=366 out=34
haiku unions=16 -> HTTP 200 stop=end_turn model=claude-haiku-5-5 in=762 out=99
haiku unions=17 -> HTTP 400 invalid_request_error: Schemas contains too many parameters with union types (17 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of ...
haiku unions=40 -> HTTP 400 invalid_request_error: Schemas contains too many parameters with union types (40 parameters ...
```

16 accepted, 17 refused; a refused request is not billed. This is the basis for `MAX_UNIONS = 16` in `services/retrieval/src/anthropic.mjs`.

## 2. Wire format through the repository's own module

Requests built by `messagesRequest` and read back by `readMessages`:

```
haiku/constrained:       HTTP 200 model=claude-haiku-5-5 guided=false unions=4  stop=stop blocks=text in=416 out=35  ~$0.00006 valid=true
haiku/guided(22 fields): HTTP 200 model=claude-haiku-5-5 guided=true  unions=24 stop=stop blocks=text in=684 out=202 ~$0.00017 valid=true
opus/high/constrained:   HTTP 200 model=claude-opus-5-5  guided=false unions=4  stop=stop blocks=text in=417 out=34  ~$0.00235 valid=true
```

Both models echo their model id exactly, which the adapter's identity check relies on.

## 3. Opus 5.5 throughput (sets the output allowance)

One heavy extraction (120 catalogue items, effort `high`, non-streaming, `max_tokens` 9000), built by the adapter's own request code:

```
{"items":120,"request_bytes":21315,"http":200,"model":"claude-opus-5-5","stop":"length","blocks":"text","input_tokens":9448,"output_tokens":9000,"wall_ms":59466,"output_tokens_per_s_incl_prefill":151.3,"valid_against_schema":false,"approx_cost_usd":0.2178}
```

`valid_against_schema` is false only because the output reached the 9,000-token cap I set for the probe (`stop: length`). The measurement is of speed: 9,000 tokens in 59.5 s, about 151 tokens/s including prefill, with no thinking block emitted. At that rate the 90 s request cap fits roughly 13,000 tokens, so the former 16,000-token allowance could not finish; the allowance is now 8,000 (about 53 s).

## 4. Schema shapes: before the nullable-enum fix

The same battery as `schema-battery-after-fix.txt`, run against `anthropic.mjs` at `4956d2f`:

```
ACCEPT  plain strings and numbers          unions= 4
REJECT  string enum, required              unions= 1  HTTP 400: output_config.format.schema: Invalid schema: Enum value 'x' does not match declared type '['string', 'null']'
REJECT  string enum, optional              unions= 2  (same)
REJECT  integer enum                       unions= 1  Enum value 1 does not match declared type '['integer', 'null']'
REJECT  boolean enum                       unions= 1  Enum value True does not match declared type '['boolean', 'null']'
ACCEPT  array of strings / array of objects / nested object / caller anyOf / caller null union / description and title keywords / enum inside array items
REJECT  Agent decision schema              unions=10  Enum value 'visit' does not match declared type '['string', 'null']'
REJECT  Agent decision + 2-field result    unions=13  (same)
```

Nullable enums were the only refused shape.

## 5. The first Agent run through the Pi, before the fix

The gateway's response to the Agent's page extraction (`/v2/scrape`, json format) on the image built from `a037d3b`:

```
http 502, error: "The page was scraped, but its json format failed: anthropic-agent rejected the request (HTTP 400, invalid_request_error): output_config.format.schema: Invalid schema: Enum value 'visit' does not match declared type '['string', 'null']'"
units[0].failure.class = PROVIDER_REJECTED, retryable = false
```

The ledger rows for these two attempts are `RELEASED` at 0 (see `ledger.txt`, 10:58:00 and 10:58:10): a request the provider refuses costs nothing and its reservation is returned.
