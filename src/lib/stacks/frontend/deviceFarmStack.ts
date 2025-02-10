import { StackProps, App, Stack } from 'aws-cdk-lib';
import { Vpc, SubnetType, IpAddresses } from 'aws-cdk-lib/aws-ec2';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as devicefarm from 'aws-cdk-lib/aws-devicefarm';

export interface DeviceFarmStackProps extends StackProps {
  // deployment stage of the VPC
  readonly stageName: string;
}

export class DeviceFarmStack extends Stack {
  constructor(app: App, id: string, props: DeviceFarmStackProps) {
    super(app, id, props);

    // Create an S3 bucket to store the app files
    const appBucket = new s3.Bucket(this, 'ReactNativeAppBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Automatically delete the bucket when stack is deleted
    });
  }
}
