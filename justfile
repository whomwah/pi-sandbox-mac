# List available tasks
default:
  @just --list

# Run test suite once (vitest)
test:
  npx vitest run

# Run tests in watch mode (re-run on changes)
test-watch:
  npx vitest
