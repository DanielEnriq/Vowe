import { executablePart } from '@vowe/core';

/**
 * What counts as running the test suite.
 *
 * Shared so that "ran the tests" means the same thing whichever agent did it —
 * a milestone should not depend on which provider was watching.
 */
export const TEST_COMMAND =
  /\b(pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|rspec|phpunit|gradle test|mvn test|tox|ctest)\b/;

/**
 * Matched against what the line actually runs, never against what it writes.
 *
 * A worker creating a file with a heredoc carries that file's text inside the
 * command string, and a source file mentioning `vitest` is not a test run —
 * before `executablePart`, writing one was reported as having run the suite.
 */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(executablePart(command));
}
