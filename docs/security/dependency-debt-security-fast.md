# `security-fast` dependency advisories (tracked, not yet remediated)

The `security-fast` CI check has been failing on `main` since before PR #1
(Safe Routing Phase 0-1). Confirmed via base/head `pnpm-lock.yaml` diff on
that PR that none of these resolved versions were introduced or changed by
it — this is pre-existing dependency debt, tracked here separately so it
isn't silently ignored.

## Advisories (from the `security-fast` job output)

| Severity | Package | Current version | Affected range | Advisory |
|---|---|---|---|---|
| CRITICAL | `@vitest/browser` | 4.1.9 | `>=4.0.0 <4.1.10` | [GHSA-p63j-vcc4-9vmv](https://github.com/advisories/GHSA-p63j-vcc4-9vmv) — Browser Mode provider commands bypass the file-access permission gate |
| HIGH | `@opentelemetry/propagator-jaeger` | 2.8.0 | `<2.9.0` | [GHSA-45rx-2jwx-cxfr](https://github.com/advisories/GHSA-45rx-2jwx-cxfr) — DoS via unhandled exception on malformed header in `JaegerPropagator` |
| HIGH | `axios` | 1.16.0 | `>=1.15.2 <1.18.0` | [GHSA-gcfj-64vw-6mp9](https://github.com/advisories/GHSA-gcfj-64vw-6mp9) — Node HTTP adapter can use an inherited proxy after interceptor config cloning |
| HIGH | `fast-uri` | 3.1.2 | `>=3.0.0 <=3.1.3` | [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) — host confusion via literal backslash authority delimiter |
| HIGH | `fast-uri` | 3.1.2 | `>=3.0.0 <3.1.3` | [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) — host confusion via failed IDN canonicalization |

## Next step

Bump each package to a version outside the affected range
(`@vitest/browser` >=4.1.10, `@opentelemetry/propagator-jaeger` >=2.9.0,
`axios` >=1.18.0, `fast-uri` >3.1.3), regenerate `pnpm-lock.yaml`, and
confirm `security-fast` passes.
