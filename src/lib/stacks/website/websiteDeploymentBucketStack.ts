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
  public readonly distributionId: string;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: WebsiteDeploymentBucketStackProps) {
    super(scope, id, props);

    // Use a predictable, unique bucket name based on stage and account
    const bucketNamePrefix = `website-${props.stageName.toLowerCase()}-${this.account}`;
    const uniqueBucketName = `${bucketNamePrefix}-${this.region}`;

    // Create S3 bucket for website hosting with an explicit physical name
    const websiteBucket = new s3.Bucket(this, 'WebsiteHostingBucket', {
      bucketName: uniqueBucketName, // Explicit bucket name
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
      versioned: true, // Enable versioning for easy rollbacks
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // Create CloudFront Origin Access Identity (OAI)
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'WebsiteOAI', {
      comment: `OAI for ${id}`,
    });

    // Grant read access to CloudFront with explicit policy statement
    websiteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipal',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [websiteBucket.arnForObjects('*')],
        principals: [
          new iam.CanonicalUserPrincipal(originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      }),
    );

    // Create basic CloudFront distribution
    // Note: This will be overridden by the DomainConfigurationStack when deployed
    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new origins.S3Origin(websiteBucket, {
          originAccessIdentity,
        }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
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

    new cdk.CfnOutput(this, 'WebsiteDistributionIdOutput', {
      value: distribution.distributionId,
      description: 'The ID of the CloudFront distribution',
      exportName: `${props.stageName}-WebsiteDistributionId`,
    });

    new cdk.CfnOutput(this, 'WebsiteURLOutput', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'The URL of the website',
      exportName: `${props.stageName}-WebsiteURL`,
    });

    // Define string properties to return values
    this.bucketArn = websiteBucket.bucketArn;
    this.bucketName = websiteBucket.bucketName;
    this.distributionId = distribution.distributionId;
    this.distributionDomainName = distribution.distributionDomainName;
  }
}
