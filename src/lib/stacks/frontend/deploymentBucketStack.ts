import { StackProps, App, Stack } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface DeploymentBucketStackProps extends StackProps {
  // deployment stage of the VPC
  readonly stageName: string;
}

export class DeploymentBucketStack extends Stack {
  readonly bucketArn: string;

  constructor(app: App, id: string, props: DeploymentBucketStackProps) {
    super(app, id, props);

    // Create an S3 bucket to store the app files in
    const appBucket = new s3.Bucket(this, 'APKandIPADeploymentBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.bucketArn = appBucket.bucketArn;
  }
}
