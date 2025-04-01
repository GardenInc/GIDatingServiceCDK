import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DomainConfigurationStackProps extends cdk.StackProps {
  readonly stageName: string;
  readonly domainName: string; // Main domain name
  readonly bucketName: string; // Name of the S3 bucket containing website content
  readonly distributionId?: string; // Existing CloudFront distribution ID, if any
}

export class DomainConfigurationStack extends cdk.Stack {
  public readonly hostedZoneId: string;
  public readonly certificateArn: string;
  public readonly domainName: string;
  public readonly distributionId: string;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: DomainConfigurationStackProps) {
    super(scope, id, props);

    // Only deploy for Beta stage
    if (props.stageName.toLowerCase() !== 'beta') {
      // For non-beta environments, just set empty values
      this.hostedZoneId = '';
      this.certificateArn = '';
      this.domainName = '';
      this.distributionId = '';
      this.distributionDomainName = '';
      return;
    }

    // Define the domain and subdomain
    const domainName = props.domainName;
    const fullDomainName = props.stageName.toLowerCase() === 'prod' 
      ? domainName 
      : `${props.stageName.toLowerCase()}.${domainName}`;

    // Create a hosted zone for the domain
    const hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName
    });

    // Create ACM certificate for CloudFront (must be in us-east-1)
    const certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
      domainName: domainName,
      subjectAlternativeNames: [`*.${domainName}`], // Includes all subdomains
      hostedZone: hostedZone,
      region: 'us-east-1', // CloudFront requires certificates in us-east-1
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Get reference to the S3 bucket
    const websiteBucket = s3.Bucket.fromBucketName(this, 'WebsiteBucket', props.bucketName);

    // Create CloudFront OAI
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'WebsiteOAI', {
      comment: `OAI for ${fullDomainName}`
    });

    // Grant OAI read access to bucket
    websiteBucket.grantRead(originAccessIdentity);

    // Create or update CloudFront distribution
    const distribution = new cloudfront.CloudFrontWebDistribution(this, 'WebsiteDistribution', {
      originConfigs: [
        {
          s3OriginSource: {
            s3BucketSource: websiteBucket,
            originAccessIdentity: originAccessIdentity
          },
          behaviors: [{ isDefaultBehavior: true }]
        }
      ],
      viewerCertificate: cloudfront.ViewerCertificate.fromAcmCertificate(certificate, {
        aliases: [domainName, `*.${domainName}`],
        securityPolicy: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        sslMethod: cloudfront.SSLMethod.SNI
      }),
      errorConfigurations: [
        {
          errorCode: 404,
          responseCode: 200,
          responsePagePath: '/index.html', // For SPA routing
          errorCachingMinTtl: 300,
        }
      ]
    });

    // Create DNS records pointing to CloudFront
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: fullDomainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
    });

    // If using apex domain (without www), create a second record for www
    if (fullDomainName === domainName) {
      new route53.ARecord(this, 'WwwAliasRecord', {
        zone: hostedZone,
        recordName: `www.${domainName}`,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
      });
    }

    // Export values for use in other stacks
    this.hostedZoneId = hostedZone.hostedZoneId;
    this.certificateArn = certificate.certificateArn;
    this.domainName = fullDomainName;
    this.distributionId = distribution.distributionId;
    this.distributionDomainName = distribution.distributionDomainName;

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: hostedZone.hostedZoneId,
      description: 'The ID of the hosted zone',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-HostedZoneId`,
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'The ARN of the certificate',
      exportName: `${props.stageName}-${domainName.replace(/\./g, '-')}-CertificateArn`,
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

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(',', hostedZone.hostedZoneNameServers || []),
      description: 'The name servers for the hosted zone. Update your domain registrar with these.',
    });
  }
}