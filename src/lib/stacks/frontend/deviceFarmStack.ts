import * as cdk from 'aws-cdk-lib';
import * as devicefarm from 'aws-cdk-lib/aws-devicefarm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface DeviceFarmStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly frontEndBuildBucketArn: string;
}

export class DeviceFarmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DeviceFarmStackProps) {
    super(scope, id, props);
    const apkFileKey = 'apk/app-debug.apk';

    // Reference the existing S3 bucket containing the APK
    const apkBucket = s3.Bucket.fromBucketArn(this, 'ApkBucket', props.frontEndBuildBucketArn);

    // Create a Device Farm Project
    const project = new devicefarm.CfnProject(this, 'AndroidTestProject', {
      name: 'AndroidAppTest',
      defaultJobTimeoutMinutes: 60,
    });

    // Create a Device Pool with common Android emulators
    const devicePool = new devicefarm.CfnDevicePool(this, 'EmulatorPool', {
      name: 'AndroidEmulatorPool',
      description: 'Pool of Android emulators for testing',
      projectArn: project.attrArn,
      rules: [
        {
          attribute: 'PLATFORM',
          operator: 'EQUALS',
          value: '"ANDROID"',
        },
        {
          attribute: 'FORM_FACTOR',
          operator: 'EQUALS',
          value: '"PHONE"',
        },
        {
          attribute: 'MANUFACTURER',
          operator: 'EQUALS',
          value: '"Google"',
        },
      ],
    });

    // Create an S3 bucket to store test results
    const resultsBucket = new s3.Bucket(this, 'TestResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create separate roles for each Lambda function to prevent circular dependencies

    // 1. Role for the start test function
    const startTestRole = new iam.Role(this, 'StartTestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Lambda function that starts Device Farm tests',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // Add permissions for the start test function
    apkBucket.grantRead(startTestRole, apkFileKey);
    startTestRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'devicefarm:CreateUpload',
          'devicefarm:GetUpload',
          'devicefarm:ListUploads',
          'devicefarm:ScheduleRun', // This is the missing permission
          'devicefarm:CreateRun', // This was in your original policy
          'devicefarm:GetDevicePool',
          'devicefarm:GetProject',
        ],
        resources: ['*'],
      }),
    );

    // 2. Role for the check status function
    const checkStatusRole = new iam.Role(this, 'CheckStatusRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Lambda function that checks Device Farm test status',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // Add permissions for the check status function
    resultsBucket.grantWrite(checkStatusRole);
    checkStatusRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'devicefarm:GetRun',
          'devicefarm:ListJobs',
          'devicefarm:ListSuites',
          'devicefarm:ListTests',
          'devicefarm:ListArtifacts',
          'devicefarm:GetJob',
          'devicefarm:GetSuite',
          'devicefarm:GetTest',
        ],
        resources: ['*'],
      }),
    );

    // Add permissions to manage EventBridge rules
    checkStatusRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:DisableRule', 'events:RemoveTargets'],
        resources: ['*'],
      }),
    );

    // 3. Role for the trigger function
    const triggerRole = new iam.Role(this, 'TriggerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Lambda function that triggers Device Farm tests',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // Add permissions for the trigger function
    triggerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutRule', 'events:PutTargets'],
        resources: ['*'],
      }),
    );

    // Create Lambda function to start a test run
    const startTestFunction = new lambda.Function(this, 'StartDeviceFarmTest', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '/deviceFarmLambdas/start-test')),
      role: startTestRole,
      timeout: cdk.Duration.minutes(15), // Maximum allowed timeout
      memorySize: 1024, // Increased to 1GB
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        REGION: 'us-west-2',
        PROJECT_ARN: project.attrArn,
        DEVICE_POOL_ARN: devicePool.attrArn,
        BUCKET_NAME: apkBucket.bucketName,
        APK_KEY: apkFileKey,
      },
    });

    // Create Lambda function to check test status
    const checkTestStatusFunction = new lambda.Function(this, 'CheckDeviceFarmTestStatus', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '/deviceFarmLambdas/check-status')),
      role: checkStatusRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512, // Kept the same
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        REGION: 'us-west-2',
        RESULTS_BUCKET_NAME: resultsBucket.bucketName,
      },
    });

    // Create a Lambda function to trigger the test and set up monitoring
    const triggerTestFunction = new lambda.Function(this, 'TriggerDeviceFarmTest', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '/deviceFarmLambdas/trigger-test')),
      role: triggerRole,
      timeout: cdk.Duration.minutes(10), // Increased to 10 minutes
      memorySize: 512, // Increased to 512MB
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        START_TEST_FUNCTION_NAME: startTestFunction.functionName,
        CHECK_STATUS_FUNCTION_ARN: checkTestStatusFunction.functionArn,
      },
    });

    // Grant the trigger function permission to invoke the start test function
    startTestFunction.grantInvoke(triggerRole);

    // Grant the trigger function permission to invoke the check status function
    checkTestStatusFunction.grantInvoke(triggerRole);

    // Outputs
    new cdk.CfnOutput(this, 'ProjectArn', {
      value: project.attrArn,
      description: 'The ARN of the Device Farm Project',
    });

    new cdk.CfnOutput(this, 'DevicePoolArn', {
      value: devicePool.attrArn,
      description: 'The ARN of the Device Pool',
    });

    new cdk.CfnOutput(this, 'ResultsBucketName', {
      value: resultsBucket.bucketName,
      description: 'The name of the bucket containing test results',
    });

    new cdk.CfnOutput(this, 'TriggerTestFunctionName', {
      value: triggerTestFunction.functionName,
      description: 'Function to invoke to start a test run',
    });
  }
}
