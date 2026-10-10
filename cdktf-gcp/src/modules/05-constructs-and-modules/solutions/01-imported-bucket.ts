/**
 * Exercise 1 — `from*`: consume a bucket you did not create through the same
 * interface.
 *
 * AWS CDK's `Bucket.fromBucketName()` returns an `IBucket` backed by nothing
 * but a name; `grant*` still works because IAM members only need the name.
 * Build the CDKTF equivalent: `importSecureBucket(scope, id, name)` returns an
 * `ISecureBucket` backed by a `google_storage_bucket` *data source* (so the
 * plan fails early if the bucket does not exist) and `grant*` helpers that
 * create additive members in the importing scope.
 */
import { Construct } from 'constructs';
import { DataGoogleStorageBucket } from '@cdktf/provider-google/lib/data-google-storage-bucket';
import { StorageBucketIamMember } from '@cdktf/provider-google/lib/storage-bucket-iam-member';
import { ISecureBucket } from '../secure-bucket';

class ImportedSecureBucket extends Construct implements ISecureBucket {
  readonly bucketName: string;
  readonly bucketUrl: string;
  readonly data: DataGoogleStorageBucket;

  constructor(scope: Construct, id: string, name: string) {
    super(scope, id);
    this.data = new DataGoogleStorageBucket(this, 'Bucket', { name });
    // Read from the data source, not from the prop: a wrong name fails at plan
    // ("bucket not found") instead of producing a dangling IAM member.
    this.bucketName = this.data.name;
    this.bucketUrl = this.data.url;
  }

  grantRead(id: string, member: string): StorageBucketIamMember {
    return new StorageBucketIamMember(this, id, { bucket: this.bucketName, role: 'roles/storage.objectViewer', member });
  }

  grantWrite(id: string, member: string): StorageBucketIamMember {
    return new StorageBucketIamMember(this, id, { bucket: this.bucketName, role: 'roles/storage.objectUser', member });
  }
}

/** The `from*` factory. A static on `SecureBucket` would be the AWS CDK idiom; a function avoids a circular import here. */
export function importSecureBucket(scope: Construct, id: string, bucketName: string): ISecureBucket {
  return new ImportedSecureBucket(scope, id, bucketName);
}
