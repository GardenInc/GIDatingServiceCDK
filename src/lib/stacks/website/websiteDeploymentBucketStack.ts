import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface WebsiteDeploymentBucketStackProps extends cdk.StackProps {
  readonly stageName: string;
}

export class WebsiteDeploymentBucketStack extends cdk.Stack {
  public readonly bucketArn: string;
  public readonly bucketName: string;

  constructor(scope: Construct, id: string, props: WebsiteDeploymentBucketStackProps) {
    super(scope, id, props);

    // Use a predictable, unique bucket name based on stage and account
    const bucketNamePrefix = `website-${props.stageName.toLowerCase()}-${this.account}`;
    const uniqueBucketName = `${bucketNamePrefix}-${this.region}`;

    // Create S3 bucket for website hosting with an explicit physical name
    const websiteBucket = new s3.Bucket(this, 'WebsiteHostingBucket', {
      bucketName: uniqueBucketName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // Export values for cross-stack references
    new cdk.CfnOutput(this, 'WebsiteBucketNameOutput', {
      value: websiteBucket.bucketName,
      description: 'The name of the S3 bucket hosting the website',
      exportName: `${props.stageName}-WebsiteBucketName`,
    });

    new cdk.CfnOutput(this, 'WebsiteBucketArnOutput', {
      value: websiteBucket.bucketArn,
      description: 'The ARN of the S3 bucket hosting the website',
      exportName: `${props.stageName}-WebsiteBucketArn`,
    });

    // Define string properties to return values
    this.bucketArn = websiteBucket.bucketArn;
    this.bucketName = websiteBucket.bucketName;
  }
}
