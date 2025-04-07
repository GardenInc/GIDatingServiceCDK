import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface DomainConfigurationStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly domainName: string; // Main domain name
  readonly bucketName: string; // Name of the S3 bucket containing website content
  readonly distributionId?: string; // Existing CloudFront distribution ID, if any
  readonly useExistingHostedZone?: boolean; // Flag to use existing hosted zone
  readonly hostedZoneId?: string; // Existing hosted zone ID if available
}

export class DomainConfigurationStack extends cdk.Stack {
  public readonly hostedZoneId: string;
  public readonly certificateArn: string;
  public readonly domainName: string;
  public readonly distributionId: string;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: DomainConfigurationStackProps) {
    super(scope, id, props);

    // Only deploy for Beta and Prod stages
    if (props.stageName.toLowerCase() !== 'beta' && props.stageName.toLowerCase() !== 'prod') {
      // For non-beta/prod environments, just set empty values
      this.hostedZoneId = '';
      this.certificateArn = '';
      this.domainName = '';
      this.distributionId = '';
      this.distributionDomainName = '';
      return;
    }

    // Define the domain and subdomain
    const domainName = props.domainName;
    const fullDomainName =
      props.stageName.toLowerCase() === 'prod' ? domainName : `${props.stageName.toLowerCase()}.${domainName}`;

    // Create or use existing Route53 hosted zone
    let hostedZone;
    if (props.useExistingHostedZone && props.hostedZoneId) {
      hostedZone = route53.HostedZone.fromHostedZoneId(this, 'ExistingHostedZone', props.hostedZoneId);
    } else {
      hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
        zoneName: domainName,
        comment: `Hosted zone for ${domainName}, managed via CDK`,
      });
    }

    // Output the nameservers for the hosted zone
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(',', hostedZone.hostedZoneNameServers || []),
      description: 'The name servers for the hosted zone. Update your Namecheap DNS with these.',
    });

    // Get the S3 bucket reference
    const websiteBucket = s3.Bucket.fromBucketName(this, 'WebsiteBucket', props.bucketName);

    // Create CloudFront OAI
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'WebsiteOAI', {
      comment: `OAI for ${fullDomainName}`,
    });

    // Grant OAI read access to bucket with explicit policy statement
    websiteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipal',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`${websiteBucket.bucketArn}/*`],
        principals: [
          new iam.CanonicalUserPrincipal(originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      }),
    );

    // Import the existing certificate by ID
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'ExistingCertificate',
      `arn:aws:acm:us-east-1:${this.account}:certificate/53943950-4479-4e30-a7fb-2cbf2ecb766f`,
    );

    // Create CloudFront log bucket with ACLs enabled (required for CloudFront logs)
    const logBucket = new s3.Bucket(this, 'CloudFrontLogBucket', {
      bucketName: `cloudfront-logs-${props.stageName.toLowerCase()}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      // Enable ACLs - required for CloudFront logs
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    });

    // Grant CloudFront service principal the permissions to write logs
    logBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetBucketAcl', 's3:PutObject'],
        resources: [logBucket.bucketArn, `${logBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'aws:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );

    // Also create CloudWatch log group for CloudFront logs
    const logGroup = new logs.LogGroup(this, 'CloudFrontLogGroup', {
      logGroupName: `/aws/cloudfront/${props.stageName.toLowerCase()}-${domainName.replace(/\./g, '-')}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add cloudfront function for default SPA routing
    const spaRedirectFunction = new cloudfront.Function(this, 'SPARedirectFunction', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          var uri = request.uri;
          
          // Check whether the URI is missing a file name.
          if (uri.endsWith('/')) {
            request.uri += 'index.html';
          } 
          // Check whether the URI is for a file that doesn't exist
          else if (!uri.includes('.')) {
            request.uri = '/index.html';
          }
          
          return request;
        }
      `),
      comment: 'Redirect all paths to index.html for SPA routing',
    });

    // Create optimized CloudFront distribution with logging enabled
    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(websiteBucket, {
          originAccessIdentity,
        }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
        functionAssociations: [
          {
            function: spaRedirectFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      errorResponses: [
        {
          httpStatus: 403, // Access Denied - replace with index.html
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404, // Not Found - replace with index.html
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      defaultRootObject: 'index.html',
      domainNames: [fullDomainName],
      certificate: certificate,
      logBucket: logBucket,
      logFilePrefix: `${props.stageName.toLowerCase()}/`, // Simplified log path
      logIncludesCookies: false, // Set to false to reduce log size
      enableLogging: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Create DNS records pointing to CloudFront
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: fullDomainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // If using apex domain (without www), create a second record for www
    if (fullDomainName === domainName) {
      new route53.ARecord(this, 'WwwAliasRecord', {
        zone: hostedZone,
        recordName: `www.${domainName}`,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    // Save the certificate ARN
    this.certificateArn = certificate.certificateArn;

    // Export values for use in other stacks
    this.hostedZoneId = hostedZone.hostedZoneId;
    this.domainName = fullDomainName;
    this.distributionId = distribution.distributionId;
    this.distributionDomainName = distribution.distributionDomainName;

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: hostedZone.hostedZoneId,
      description: 'The ID of the hosted zone',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-HostedZoneId`,
    });

    new cdk.CfnOutput(this, 'DomainName', {
      value: fullDomainName,
      description: 'The domain name for the website',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-DomainName`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'The ID of the CloudFront distribution',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-DistributionId`,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'The domain name of the CloudFront distribution',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-DistributionDomainName`,
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificateArn,
      description: 'The ARN of the ACM certificate',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-CertificateArn`,
    });

    new cdk.CfnOutput(this, 'LogBucketName', {
      value: logBucket.bucketName,
      description: 'The S3 bucket for CloudFront logs',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-LogBucketName`,
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'The CloudWatch log group for CloudFront logs',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-LogGroupName`,
    });

    // Add a CloudFront invalidation command output
    new cdk.CfnOutput(this, 'InvalidationCommand', {
      value: `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths "/*"`,
      description: 'Command to invalidate CloudFront cache after deployment',
    });
  }
}
