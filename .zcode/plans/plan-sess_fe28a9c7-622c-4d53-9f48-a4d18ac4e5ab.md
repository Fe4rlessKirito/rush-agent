Implement scope-aware passive Bug Bounty tool enforcement with a small, centralized change set.

## Plan

1. Inspect the relevant files directly before editing:
   - `src/core/bugBountyRuntime.ts`
   - `src/core/bugBountyScope.ts`
   - `src/core/bugBountyStore.ts`
   - `src/core/agent/webTools.ts`
   - `src/core/agent/browserTools.ts`
   - existing tests for web/browser tools if present.

2. Add or refine a helper module/API for active Bug Bounty scope enforcement:
   - Read the active program from `useBugBountyStore.getState()`.
   - Use `checkBugBountyScope(...)` and `requiredHeadersForProgram(...)`.
   - Return clear user-visible blocked messages for:
     - no active program/profile selected
     - target URL out of scope
     - invalid/uncheckable target URL if applicable.
   - Preserve required header merging for allowed targets.

3. Wire scope enforcement into passive fetch tools only:
   - Confirm `WebFetch` is already scoped and fix it only if it does not match the requested behavior.
   - Fix `website_environment` and `ui_inspect` to actually perform the scope check before fetching, using the existing/intended helper instead of the current undefined `scope` reference.
   - Add `screenshot_url` scope enforcement when it receives/targets a URL. If supported by the backend path, pass merged required headers; otherwise at minimum block out-of-scope URLs before the navigation/capture attempt.

4. Browser navigation/open tools:
   - Add scope-checked wrappers only for simple URL navigation tools (`browser_open`, `browser_navigate`) if their argument shape is straightforward.
   - Leave broader browser automation tools unchanged for a later pass.

5. Keep behavior explicitly safe and non-exploitative:
   - Do not add scanners, fuzzers, credential features, DoS/load behavior, stealth/evasion, or automated HackerOne submission.
   - Keep messages framed as scope/permission blocks so the AI/tool caller can understand why the request did not run.

6. Add or update focused tests where practical:
   - Block when no active profile exists.
   - Block out-of-scope URLs.
   - Allow in-scope URLs and merge required headers.
   - Cover `website_environment`, `ui_inspect`, `screenshot_url`, and simple navigation wrappers if feasible with existing test patterns.

7. Run `npm run build` and fix any TypeScript issues. If existing tests are lightweight and relevant, run them too; otherwise report build status and any skipped test commands.