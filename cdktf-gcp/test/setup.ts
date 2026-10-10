// Registers cdktf's jest matchers (toHaveResource, toHaveResourceWithProperties, toBeValidTerraform, …).
// Importing the adapter only loads the types; `setupJest()` is what calls `expect.extend`.
import { Testing } from 'cdktf';
import 'cdktf/lib/testing/adapters/jest';

Testing.setupJest();
