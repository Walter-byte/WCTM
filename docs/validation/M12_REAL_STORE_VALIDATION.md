# M12 Real-Store Validation — Final Record

Status: COMPLETE TO THE EXTENT DOCUMENTED

Environment: approved VPS Docker Compose environment behind Caddy, connected
to a real WooCommerce test Store

Scope: M12 Telegram order-status write path

This is the canonical final M12 validation record. It consolidates the
repository validation history, the supplied later validation record, and the
validated timeout correction in Git. The two supplied Markdown records were
byte-for-byte identical at consolidation time; therefore no additional manual
PASS or FAIL result is inferred from the second path.

No production customer order or payment data is recorded here.

## Evidence classification

- **Manual real-store validation** means an operator exercised the deployed
  Telegram and WooCommerce flow against the real test Store.
- **Automated evidence** means repository tests or structural constraints cover
  the behavior; it is not represented as a manual execution.
- **Blocked** means the case was not safely executable through an approved
  product or fault-injection path.
- **Not documented as executed** means the available records do not contain a
  manual result. No result is inferred.

## Readiness evidence

### R0 — Runtime and migration readiness

**Manual result: PASS (2026-07-24).**

The recorded recovery and readiness work established that:

- the stale backend image was rebuilt;
- the backend command was corrected to `node dist/main.js`;
- all eight migrations were applied with `prisma migrate deploy`;
- backend and Telegram bot services were recreated with synchronized local
  configuration;
- backend restart count remained zero;
- PostgreSQL and Redis readiness passed;
- backend liveness and readiness passed;
- Telegram polling started; and
- no configured secret values were observed in the reviewed logs.

### R1 — M12-V pilot setup and readiness

The supported `pilot:setup` and `pilot:readiness` implementation is merged.
The supplied records do not retain the nine-check readiness output, so R1 is
**not separately documented as manually executed** in this final record.

The later real-store status-write regression described below demonstrates that
the linked Telegram-to-WooCommerce path was operational for that validation;
it does not retroactively create missing R1 checklist evidence.

## Validation case results

| Case                                             | Evidence class                                | Final recorded result                             | Factual basis                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 — OWNER/ADMIN successful status update        | Manual real-store                             | **PASS after correction; FAIL before correction** | Before the correction, WooCommerce reached the selected target state but Telegram timed out and reported “service is temporarily unavailable,” so the full V1 experience failed. After the correction, the real-store regression completed in approximately 7–13 seconds, WooCommerce reached the selected target state, and Telegram no longer produced that unavailable message. |
| V2 — MEMBER denial                               | Manual                                        | **BLOCKED / not executed**                        | No supported second MEMBER fixture/account was documented. An OWNER role was not changed through direct SQL.                                                                                                                                                                                                                                                                       |
| V3 — invalid or expired callback                 | Manual expiry; automated tamper evidence      | **Not documented as manually executed**           | Repository tests cover callback authentication/tampering. No manual expiry result is retained.                                                                                                                                                                                                                                                                                     |
| V4 — duplicate callback                          | Automated evidence                            | **Automated evidence only**                       | M12 tests cover idempotent replay, and the database uniquely constrains callback reference plus target. No manual double-tap result is retained.                                                                                                                                                                                                                                   |
| V5 — delayed callback                            | Manual                                        | **Not documented as executed**                    | No safe manual result is retained.                                                                                                                                                                                                                                                                                                                                                 |
| V6 — active context changed before callback      | Blocked; automated evidence only              | **BLOCKED / not safely executable**               | M10 has no supported tenant/Store context-switching flow, and direct database mutation was prohibited. Existing integration tests are the only recorded safe evidence.                                                                                                                                                                                                             |
| V7 — WooCommerce unreachable before confirmation | Blocked; automated evidence only              | **BLOCKED / not safely executable**               | No approved fault-injection control or disposable test path was available. Ad hoc DNS, credential, Store, or system-network changes were prohibited.                                                                                                                                                                                                                               |
| V8 — ambiguous timeout after dispatch            | Blocked; automated evidence only              | **BLOCKED / not safely executable**               | No approved mechanism could allow WooCommerce to commit while dropping only the response. Automated lost-response reconciliation tests are the only recorded safe evidence.                                                                                                                                                                                                        |
| V9 — authoritative reconciliation                | Manual, associated with V1                    | **Not independently documented**                  | The real Store reached the selected target state. The supplied record does not retain a three-source WooCommerce/local-projection/Telegram comparison, so a full manual V9 PASS is not claimed.                                                                                                                                                                                    |
| V10 — local Order projection update              | Manual, associated with V1                    | **Not independently documented**                  | No retained `orders.status` and `last_synced_at` evidence is present, so a manual PASS is not claimed.                                                                                                                                                                                                                                                                             |
| V11 — Telegram message-edit fallback             | Automated evidence                            | **Automated evidence only**                       | The Telegram bot tests force `editMessageText` failure and verify fallback to a new message. No manual reproduction is claimed or required by the original plan.                                                                                                                                                                                                                   |
| V12 — bot/backend restart safety                 | Manual                                        | **Not documented as executed**                    | No retained restart-validation result is present.                                                                                                                                                                                                                                                                                                                                  |
| V13 — audit and secret-leak review               | Manual review                                 | **Not documented as executed**                    | R0 includes a secret-free log observation, but the later V13-specific audit/log review is not retained and is not inferred.                                                                                                                                                                                                                                                        |
| V14 — no duplicate WooCommerce writes            | Manual database audit plus automated evidence | **Automated evidence only**                       | Durable target claiming, the unique status-write constraint, and M12 replay tests cover the single-effect boundary. No retained manual database/access-log audit is present.                                                                                                                                                                                                       |

## Status-write timeout finding and correction

The initial real-store status change exposed a transport deadline mismatch:

- WooCommerce completed the requested status change successfully;
- the end-to-end operation exceeded the bot's general 5,000ms backend timeout;
- Telegram therefore reported “service is temporarily unavailable” even though
  the Store had reached the selected target state.

The validated correction is in commit `fe36ab2`:
`fix(telegram): align status-write timeout with WooCommerce workflow`.

The correction gives M12 status writes a dedicated bounded
`BOT_STATUS_WRITE_TIMEOUT_MS` deadline, defaulting to 50,000ms, while retaining
the existing general timeout for read-only and short operations. It does not
add a backend request retry or a WooCommerce write retry.

After deployment of the correction, the real-store regression took
approximately **7–13 seconds**. WooCommerce reached the selected target state,
and Telegram no longer returned the unavailable message. The timeout defect is
therefore **fixed and manually validated for the exercised real-store path**.

## Operational latency observation

Real-world WooCommerce order-status writes took approximately 7–13 seconds in
this environment. Iranian network restrictions and network instability can
materially affect that latency. Deployment and network-resilience planning
must account for this operational condition while preserving bounded requests,
single-effect writes, and truthful Telegram outcomes.

This observation records an operating constraint only. It does not propose an
infrastructure move or an architecture change.

## Automated evidence

The repository provides automated coverage and structural evidence for:

- callback signature, purpose, expiry, and context validation;
- OWNER/ADMIN write authorization and MEMBER read-only behavior;
- first-target claiming and idempotent replay;
- the unique callback-reference-plus-target write boundary;
- one WooCommerce write dispatch without automatic write retry;
- ambiguous-response live reconciliation;
- authoritative projection behavior;
- Telegram edit-to-reply fallback; and
- dedicated status-write timeout configuration and transport behavior added by
  the timeout correction.

Automated evidence supplements the manual real-store result; it is not recorded
as manual execution of V2–V14.

## Final validation conclusion

M12 implementation is complete and merged. The core OWNER/ADMIN real-store
order-status write path is manually validated after correction of the bot
transport timeout: the exercised writes completed in approximately 7–13
seconds, WooCommerce reached the selected target state, and Telegram no longer
reported a false temporary-unavailability outcome.

M12 real-store validation is complete **to the extent documented**. This is not
a claim that every V1–V14 case was manually executed. V6–V8 remain blocked and
not safely executable through the approved paths; V2 is also blocked for lack
of a supported MEMBER fixture. Cases identified above as automated-only or not
documented as executed retain those evidence limits.

The available evidence supports handing Phase 4 to A/B for closure review. It
does not define or begin a new implementation milestone.
