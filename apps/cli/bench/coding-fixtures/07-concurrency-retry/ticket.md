# Ticket: retried jobs apply their side effect twice

The job runner in src/runner.cjs retries an attempt that exceeds its timeout. When a timed-out attempt finishes late, its result is still applied, and the retry applies its own result too, so the job's side effect (for example a payout) happens twice. A late failure from a timed-out attempt also schedules extra retries, and the failure callback can fire more than once for one run. Submitting the same job twice while it is running starts two independent runs.

createRunner({clock, timeoutMs, maxAttempts, backoffMs, onSuccess, onFailure}) returns {run(job)}. The clock is injected: clock.setTimeout(fn, ms) returns a handle and clock.clearTimeout(handle) cancels it. Use only the injected clock for timers. onSuccess and onFailure are optional.

A job is {id, execute(attempt), apply(value)}. execute returns a value or a Promise; apply performs the side effect.

Expected behaviour of run(job), which returns a Promise:

- Attempt numbers start at 1. Each attempt calls execute(attempt) and races it against timeoutMs. execute throwing synchronously counts as that attempt failing.
- An attempt that times out is abandoned. Anything it later resolves or rejects is ignored completely: no apply, no callbacks, no extra retries, no effect on the result.
- A failed or timed-out attempt is retried while attempts < maxAttempts. The delay before attempt k+1 is backoffMs * 2^(k-1) (so backoffMs, then 2*backoffMs, ...). The next attempt must not start before that delay.
- On the first successful attempt: clear its timeout, call job.apply(value) exactly once, call onSuccess(job.id, value) once, and resolve {status:'ok', value, attempts}. No further attempts start.
- If job.apply throws, the run is not retried (the side effect may be partial): call onFailure(job.id, error) once and resolve {status:'failed', error, attempts}.
- When the last attempt fails or times out: call onFailure(job.id, error) exactly once and resolve {status:'failed', error, attempts}. For a timeout the error is an Error whose message is 'timeout'.
- run never rejects.
- Calling run with a job id that is already in flight returns the same Promise and starts nothing new. Once a run settles, the id may be run again.

Constraints: change src/runner.cjs only. Keep the exports. No real timers, no dependencies. Do not change the tests.

Run node --test public.test.cjs. Hidden evaluation drives the fake clock through late successes, late failures, backoff timing, apply errors and duplicate submissions.
