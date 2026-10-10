# Contributing

This is a personal mastery repo, but it is built to be extended.

- Every module follows [`docs/MODULE-TEMPLATE.md`](docs/MODULE-TEMPLATE.md): README, source, `index.ts` exporting `addToApp(app)`, a test file, and three exercises with tested solutions.
- Stack ids are `M<NN>-…` (AWS CDK) and `m<NN>-…` (CDKTF) so the curriculum reads in `cdk ls` / `cdktf list`.
- Nothing may require credentials, Docker, or a Terraform binary to synthesize or test. Gate anything that does behind an environment variable and say so in the README.
- Type-check one module in isolation with `scripts/typecheck-module.sh <aws-cdk|cdktf-gcp> <NN-slug>`; run its tests with `npx jest test/<NN-slug>.test.ts` from the track directory.
- Every claim about framework behaviour must be true for the pinned versions in [`docs/CURRICULUM.md`](docs/CURRICULUM.md); when it depends on a version, say which.
