import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
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

    // Create Route53 hosted zone
    const hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName,
      comment: `Hosted zone for ${domainName}, managed via CDK`,
    });

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

    // Grant OAI read access to bucket
    websiteBucket.grantRead(originAccessIdentity);

    // Create CloudFront distribution without a certificate first
    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(websiteBucket, {
          originAccessIdentity,
        }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html', // For SPA routing
        },
      ],
      defaultRootObject: 'index.html',
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

    // Set placeholder value for certificate ARN
    this.certificateArn = 'manual-certificate-creation-required';

    // Add instructions for certificate creation and validation
    new cdk.CfnOutput(this, 'ManualSteps', {
      value: `After updating your Namecheap DNS with the Route53 nameservers, follow these steps:

1. Request a certificate in ACM:
   aws acm request-certificate --region us-east-1 --profile beta \\
     --domain-name ${domainName} \\
     --subject-alternative-names "*.${domainName}" \\
     --validation-method DNS

2. Get the certificate ARN:
   aws acm list-certificates --region us-east-1 --profile beta --query "CertificateSummaryList[?DomainName=='${domainName}']"

3. Get validation record details:
   aws acm describe-certificate --region us-east-1 --profile beta --certificate-arn YOUR_CERT_ARN

4. Create validation records in Route53:
   aws route53 change-resource-record-sets --hosted-zone-id ${hostedZone.hostedZoneId} --profile beta \\
     --change-batch file://validation-records.json

   (Create validation-records.json with the proper validation data from step 3)

5. Update CloudFront with the certificate once validated:
   aws cloudfront update-distribution --id ${distribution.distributionId} --profile beta \\
     --viewer-certificate "CertificateSource=acm,ACMCertificateArn=YOUR_CERT_ARN,SSLSupportMethod=sni-only,MinimumProtocolVersion=TLSv1.2_2021"`,
      description: 'Manual steps for certificate setup',
    });

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
  }
}
