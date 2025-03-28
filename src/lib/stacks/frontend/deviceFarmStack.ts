import { StackProps, App, Stack } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as devicefarm from 'aws-cdk-lib/aws-devicefarm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';

export interface DeviceFarmStackProps extends StackProps {
  // deployment stage of the VPC
  readonly stageName: string;
}

export class DeviceFarmStack extends Stack {
  readonly bucketArn: string;

  constructor(app: App, id: string, props: DeviceFarmStackProps) {
    super(app, id, props);

    // Create an S3 bucket to store the app files in
    const appBucket = new s3.Bucket(this, 'APKandIPAstoreBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.bucketArn = appBucket.bucketArn;

    // Create seperate IAM role for people access device farm.
    // 1. just to test with device farm (mason, cash, any others)
    // 2. debugging pipeline and build specs (charlie)
  }
}

/*
export class DeviceFarmStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
      super(scope, id, props);
  
      // 1. Create an S3 Bucket to upload the APK/IPA file
      const s3Bucket = new s3.Bucket(this, 'ExpoAppBucket', {
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Automatically clean up when stack is deleted
      });
  
      // 2. Upload the APK/IPA file to S3
      const filePath = path.join(__dirname, 'path-to-your-apk-or-ipa-file'); // Adjust path accordingly
      new s3.CfnBucketObject(this, 'ExpoAppFile', {
        bucket: s3Bucket.bucketName,
        key: 'app.apk', // Name your app APK or IPA file
        source: filePath,
      });
  
      // 3. Create Device Farm project
      const project = new devicefarm.CfnProject(this, 'ExpoAppProject', {
        name: 'ExpoAppProject',
      });
  
      // 4. Create Device Pool (select devices to run your tests)
      const devicePool = new devicefarm.CfnDevicePool(this, 'DevicePool', {
        projectArn: project.attrArn,
        name: 'ExpoDevicePool',
        rules: [
          {
            attribute: 'ARN',
            operator: 'IN',
            value: ['arn:aws:devicefarm:us-west-2::device:ANDROID_123', 'arn:aws:devicefarm:us-west-2::device:IOS_456'], // Example devices
          },
        ],
      });
  
      // 5. Create a Run to execute the test
      const run = new devicefarm.CfnRun(this, 'ExpoAppRun', {
        name: 'ExpoAppRun',
        projectArn: project.attrArn,
        devicePoolArn: devicePool.attrArn,
        appUpload: {
          type: 'ANDROID_APP',
          appArn: s3Bucket.bucketArn + '/app.apk', // Reference the APK in S3
        },
        test: {
          type: 'APPIUM_NODE', // Select the appropriate test type (Appium for mobile tests)
          testSpecArn: 'arn:aws:devicefarm:us-west-2::testspec:appium', // Or your custom test spec
        },
      });
    }
}
*/
