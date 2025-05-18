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
import { STAGES } from '../../utils/config';

export interface DomainConfigurationStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly domainName: string; // Main domain name
  readonly bucketName: string; // Name of the S3 bucket containing website content
  readonly certificateArn: string; // existing certificate ARN
  readonly distributionId?: string; // Existing CloudFront distribution ID, if any
  readonly deployDistribution?: boolean; // Flag to control if CloudFront distribution should be deployed
}

export class DomainConfigurationStack extends cdk.Stack {
  // Public properties for external access
  public readonly hostedZoneId: string;
  public readonly certificateArn: string;
  public readonly domainName: string;
  public readonly distributionId: string;
  public readonly distributionDomainName: string;

  // Private properties
  private readonly props: DomainConfigurationStackProps;
  private readonly fullDomainName: string;
  private readonly stageName: string;

  constructor(scope: Construct, id: string, props: DomainConfigurationStackProps) {
    super(scope, id, props);

    this.props = props;
    this.stageName = props.stageName;
    this.fullDomainName = this.formatDomainName(props.domainName, props.stageName);

    // Determine if we should deploy the distribution based on stage and flag
    // Always deploy for Beta, conditionally deploy for Prod
    const shouldDeployDistribution =
      props.stageName !== STAGES.PROD || (props.deployDistribution !== undefined ? props.deployDistribution : true);

    // Create hosted zone (always create this)
    const hostedZone = this.createHostedZone(props.domainName);
    this.createSubdomainDelegation(hostedZone);

    // If we're not deploying the distribution (Prod + flag off), just set up the hosted zone
    if (!shouldDeployDistribution) {
      // Still need to set required properties, but with placeholder values
      this.hostedZoneId = hostedZone.hostedZoneId;
      this.domainName = this.fullDomainName;
      this.distributionId = props.distributionId || 'distribution-not-deployed';
      this.distributionDomainName = 'distribution-not-deployed.cloudfront.net';
      this.certificateArn = props.certificateArn;

      // Create outputs for hosted zone info
      this.createHostedZoneOutputs(hostedZone);

      // Add a note about distribution being skipped
      new cdk.CfnOutput(this, 'DistributionStatus', {
        value: 'CloudFront distribution deployment was skipped as requested',
        description: 'Status of CloudFront distribution deployment',
      });

      // Early return - don't create distribution or other resources
      return;
    }

    // If we get here, we're deploying the full stack including distribution

    // Create all resources
    const websiteBucket = this.getBucketReference(props.bucketName);
    const originAccessIdentity = this.createOriginAccessIdentity();
    const certificate = this.getCertificate();
    const { logBucket, logGroup } = this.createLoggingResources(props.domainName);

    // Configure bucket policies
    this.configureBucketPolicies(websiteBucket, originAccessIdentity);

    // Create CloudFront functions
    const functions = this.createCloudFrontFunctions();

    // Create distribution
    const distribution = this.createDistribution({
      websiteBucket,
      originAccessIdentity,
      certificate,
      logBucket,
      functions,
    });

    // Create DNS records
    this.createDnsRecords(hostedZone, distribution);

    // Set public properties
    this.hostedZoneId = hostedZone.hostedZoneId;
    this.domainName = this.fullDomainName;
    this.distributionId = distribution.distributionId;
    this.distributionDomainName = distribution.distributionDomainName;

    if (certificate) {
      this.certificateArn = certificate.certificateArn;
    }

    // Create outputs
    this.createOutputs({
      hostedZone,
      distribution,
      logBucket,
      logGroup,
    });
  }

  // Add this method to the DomainConfigurationStack class
  private createSubdomainDelegation(hostedZone: route53.PublicHostedZone): void {
    // Only create this record in the Prod environment
    if (this.stageName === STAGES.PROD) {
      // Create NS record for beta subdomain in the production hosted zone
      new route53.NsRecord(this, 'BetaSubdomainDelegation', {
        zone: hostedZone,
        recordName: 'beta',
        values: ['ns-381.awsdns-47.com', 'ns-525.awsdns-01.net', 'ns-1366.awsdns-42.org', 'ns-1717.awsdns-22.co.uk'],
        ttl: cdk.Duration.minutes(5),
      });

      // Add output to show this was created
      new cdk.CfnOutput(this, 'BetaSubdomainDelegationCreated', {
        value: 'Beta subdomain delegation NS record has been created',
        description: 'Indicates that the NS record for beta.qandmedating.com has been created in the production zone',
      });
    }
  }

  /**
   * Creates outputs specifically for the hosted zone when skipping distribution
   */
  private createHostedZoneOutputs(hostedZone: route53.PublicHostedZone): void {
    // HostedZone ID output
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: hostedZone.hostedZoneId,
      description: 'The ID of the hosted zone',
      exportName: `${this.stageName}-${this.props.domainName.replace(/\./g, '-')}-HostedZoneId`,
    });

    // Domain name output
    new cdk.CfnOutput(this, 'DomainName', {
      value: this.fullDomainName,
      description: 'The domain name for the website',
      exportName: `${this.stageName}-${this.props.domainName.replace(/\./g, '-')}-DomainName`,
    });

    // Output the nameservers for the hosted zone
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(',', hostedZone.hostedZoneNameServers || []),
      description: 'The name servers for the hosted zone. Update your Namecheap DNS with these.',
    });

    // Add next steps guidance
    new cdk.CfnOutput(this, 'NextSteps', {
      value: `
1. Copy the above name servers (comma-separated list)
2. Update DNS settings in Namecheap for ${this.props.domainName}
3. Request SSL certificate for *.${this.props.domainName} and ${this.props.domainName}
4. Update PROD_CERTIFICATE_ARN in constants.ts with the new certificate ARN
5. Set DEPLOY_PROD_DISTRIBUTION to true in constants.ts
6. Run CDK deploy again to create the distribution
      `,
      description: 'Next steps to complete the setup',
    });
  }

  /**
   * Formats the full domain name based on environment
   */
  private formatDomainName(domainName: string, stageName: string): string {
    return stageName === STAGES.PROD ? domainName : `${stageName.toLowerCase()}.${domainName}`;
  }

  /**
   * Creates or uses an existing Route53 hosted zone
   */
  private createHostedZone(domainName: string): route53.PublicHostedZone {
    const hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName,
      comment: `Hosted zone for ${domainName}, managed via CDK`,
    });

    return hostedZone;
  }

  /**
   * Gets a reference to the S3 bucket
   */
  private getBucketReference(bucketName: string): s3.IBucket {
    return s3.Bucket.fromBucketName(this, 'WebsiteBucket', bucketName);
  }

  /**
   * Creates a CloudFront Origin Access Identity
   */
  private createOriginAccessIdentity(): cloudfront.OriginAccessIdentity {
    return new cloudfront.OriginAccessIdentity(this, 'WebsiteOAI', {
      comment: `OAI for ${this.fullDomainName}`,
    });
  }

  /**
   * Configures the bucket policies for S3 access
   */
  private configureBucketPolicies(bucket: s3.IBucket, originAccessIdentity: cloudfront.OriginAccessIdentity): void {
    // Grant OAI read access to bucket with explicit policy statement
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipal',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`${bucket.bucketArn}/*`],
        principals: [
          new iam.CanonicalUserPrincipal(originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      }),
    );

    // Add an additional policy statement for CloudFront service principal
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipalReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${this.distributionId}`,
          },
        },
      }),
    );
  }

  /**
   * Gets a certificate based on environment
   */
  private getCertificate(): acm.ICertificate | undefined {
    if (this.stageName === STAGES.BETA) {
      return acm.Certificate.fromCertificateArn(this, 'ExistingCertificate', this.props.certificateArn);
    }
    return undefined;
  }

  /**
   * Creates logging resources for CloudFront
   */
  private createLoggingResources(domainName: string): {
    logBucket: s3.Bucket;
    logGroup: logs.LogGroup;
  } {
    // Create CloudFront log bucket with ACLs enabled (required for CloudFront logs)
    const logBucket = new s3.Bucket(this, 'CloudFrontLogBucket', {
      bucketName: `cloudfront-logs-${this.stageName.toLowerCase()}-${this.account}-${this.region}`,
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
      logGroupName: `/aws/cloudfront/${this.stageName.toLowerCase()}-${domainName.replace(/\./g, '-')}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    return { logBucket, logGroup };
  }

  /**
   * Creates CloudFront functions for the distribution
   */
  private createCloudFrontFunctions(): {
    functionAssociations: cloudfront.FunctionAssociation[];
  } {
    const functionAssociations: cloudfront.FunctionAssociation[] = [];

    // Add SPA redirect function
    const spaRedirectFunction = this.createSpaRedirectFunction();
    functionAssociations.push({
      function: spaRedirectFunction,
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
    });

    // Add basic auth function for Beta environment
    if (this.stageName === STAGES.BETA) {
      const basicAuthFunction = this.createBasicAuthFunction();
      functionAssociations.push({
        function: basicAuthFunction,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      });
    }

    return { functionAssociations };
  }

  /**
   * Creates the SPA redirect function for CloudFront
   */
  private createSpaRedirectFunction(): cloudfront.Function {
    return new cloudfront.Function(this, 'SPARedirectFunction', {
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
  }

  /**
   * Creates the basic auth function for CloudFront
   */
  private createBasicAuthFunction(): cloudfront.Function {
    // Generate base64 encoded credential string for testUser:qandmedating
    // This is equivalent to: echo -n "testUser:qandmedating" | base64
    const encodedCredentials = 'Basic dGVzdFVzZXI6cWFuZG1lZGF0aW5n';

    return new cloudfront.Function(this, 'BasicAuthFunction', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          var headers = request.headers;
          
          // Check for the authorization header
          if (!headers.authorization || headers.authorization.value !== '${encodedCredentials}') {
            return {
              statusCode: 401,
              statusDescription: 'Unauthorized',
              headers: {
                'www-authenticate': { value: 'Basic realm="Beta Access"' }
              }
            };
          }
          
          return request;
        }
      `),
      comment: 'Basic authentication for beta environment',
    });
  }

  /**
   * Creates the CloudFront distribution
   */
  private createDistribution(props: {
    websiteBucket: s3.IBucket;
    originAccessIdentity: cloudfront.OriginAccessIdentity;
    certificate?: acm.ICertificate;
    logBucket: s3.Bucket;
    functions: { functionAssociations: cloudfront.FunctionAssociation[] };
  }): cloudfront.Distribution {
    return new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(props.websiteBucket, {
          originAccessIdentity: props.originAccessIdentity,
        }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
        functionAssociations: props.functions.functionAssociations,
      },
      errorResponses: this.getErrorResponses(),
      defaultRootObject: 'index.html',
      domainNames: [this.fullDomainName],
      certificate: props.certificate,
      logBucket: props.logBucket,
      logFilePrefix: `${this.stageName.toLowerCase()}/`, // Simplified log path
      logIncludesCookies: false, // Set to false to reduce log size
      enableLogging: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
  }

  /**
   * Returns CloudFront error responses configurations
   */
  private getErrorResponses(): cloudfront.ErrorResponse[] {
    return [
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
    ];
  }

  /**
   * Creates DNS records for the distribution
   */
  private createDnsRecords(hostedZone: route53.PublicHostedZone, distribution: cloudfront.Distribution): void {
    // Create DNS record pointing to CloudFront
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: this.fullDomainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // If using apex domain (without www), create a second record for www
    if (this.fullDomainName === this.props.domainName) {
      new route53.ARecord(this, 'WwwAliasRecord', {
        zone: hostedZone,
        recordName: `www.${this.props.domainName}`,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    // Add email records for production
    if (this.stageName === STAGES.PROD) {
      this.createEmailRecords(hostedZone);
    }
  }

  /**
   * Creates email-related DNS records
   */
  private createEmailRecords(hostedZone: route53.PublicHostedZone): void {
    // MX records for email
    new route53.MxRecord(this, 'MxRecords', {
      zone: hostedZone,
      recordName: this.fullDomainName,
      values: [
        {
          hostName: 'mx1.improvmx.com',
          priority: 10,
        },
        {
          hostName: 'mx2.improvmx.com',
          priority: 20,
        },
      ],
      ttl: cdk.Duration.minutes(5),
    });

    // SPF record for email authentication
    new route53.TxtRecord(this, 'SpfRecord', {
      zone: hostedZone,
      recordName: this.fullDomainName,
      values: ['v=spf1 include:spf.improvmx.com -all'],
      ttl: cdk.Duration.minutes(5),
    });
  }

  /**
   * Creates CloudFormation outputs
   */
  private createOutputs(props: {
    hostedZone: route53.PublicHostedZone;
    distribution: cloudfront.Distribution;
    logBucket: s3.Bucket;
    logGroup: logs.LogGroup;
  }): void {
    const domainNameForExport = this.props.domainName.replace(/\./g, '-');

    // HostedZone ID output
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: props.hostedZone.hostedZoneId,
      description: 'The ID of the hosted zone',
      exportName: `${this.stageName}-${domainNameForExport}-HostedZoneId`,
    });

    // Domain name output
    new cdk.CfnOutput(this, 'DomainName', {
      value: this.fullDomainName,
      description: 'The domain name for the website',
      exportName: `${this.stageName}-${domainNameForExport}-DomainName`,
    });

    // Add login credentials output for Beta environment
    if (this.stageName === STAGES.BETA) {
      new cdk.CfnOutput(this, 'BetaCredentials', {
        value: 'Username: testUser, Password: qandmedating',
        description: 'Login credentials for beta website access',
      });
    }

    // Distribution ID output
    new cdk.CfnOutput(this, 'DistributionId', {
      value: props.distribution.distributionId,
      description: 'The ID of the CloudFront distribution',
      exportName: `${this.stageName}-${domainNameForExport}-DistributionId`,
    });

    // Distribution domain name output
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: props.distribution.distributionDomainName,
      description: 'The domain name of the CloudFront distribution',
      exportName: `${this.stageName}-${domainNameForExport}-DistributionDomainName`,
    });

    // Log bucket name output
    new cdk.CfnOutput(this, 'LogBucketName', {
      value: props.logBucket.bucketName,
      description: 'The S3 bucket for CloudFront logs',
      exportName: `${this.stageName}-${domainNameForExport}-LogBucketName`,
    });

    // Log group name output
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: props.logGroup.logGroupName,
      description: 'The CloudWatch log group for CloudFront logs',
      exportName: `${this.stageName}-${domainNameForExport}-LogGroupName`,
    });

    // CloudFront invalidation command output
    new cdk.CfnOutput(this, 'InvalidationCommand', {
      value: `aws cloudfront create-invalidation --distribution-id ${props.distribution.distributionId} --paths "/*" --profile ${this.stageName.toLowerCase()}`,
      description: 'Command to invalidate CloudFront cache after deployment',
    });
  }
}
