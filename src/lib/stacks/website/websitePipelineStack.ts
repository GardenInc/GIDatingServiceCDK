import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities, SecretValue, Duration } from 'aws-cdk-lib';
import { WebsiteStackConfigInterface } from '../../utils/config';
import { SECRET_NAME, WebsitePipelineStackName, TEMPLATE_ENDING, WEBSITE_BUCKET_STACK } from '../../utils/constants';
import { pipelineAccountId } from '../../utils/accounts';

export interface WebsitePipelineStackProps extends StackProps {
  readonly stacksToDeploy: WebsiteStackConfigInterface[];
}

/**
 * Components for the Website Pipeline Stack
 */
namespace PipelineComponents {
  /**
   * Configuration related types and helpers
   */
  export interface AccountConfig {
    accountId: string;
    roles: {
      cloudFormation: iam.IRole;
      codePipeline: iam.IRole;
    };
    principal: iam.IPrincipal;
    websiteConfig: WebsiteStackConfigInterface;
  }

  /**
   * Creates security resources for the pipeline
   */
  export class SecurityManager {
    public readonly key: kms.Key;
    public readonly artifactBucket: s3.Bucket;

    constructor(scope: Stack, betaConfig: AccountConfig, prodConfig: AccountConfig) {
      this.key = this.createKmsKey(scope, betaConfig, prodConfig);
      this.artifactBucket = this.createArtifactBucket(scope, this.key, betaConfig, prodConfig);
    }

    private createKmsKey(scope: Stack, betaConfig: AccountConfig, prodConfig: AccountConfig): kms.Key {
      const key = new kms.Key(scope, 'ArtifactKey', {
        alias: 'key/website-pipeline-artifact-key',
        enableKeyRotation: true,
        description: 'KMS key for website pipeline artifacts',
      });

      // Add explicit key policy for cross-account access
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountAccess',
          effect: iam.Effect.ALLOW,
          principals: [betaConfig.principal, prodConfig.principal],
          actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
          resources: ['*'],
        }),
      );

      // Add explicit key policy for the cross-account roles
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountRoleAccess',
          effect: iam.Effect.ALLOW,
          principals: [
            new iam.ArnPrincipal(betaConfig.roles.codePipeline.roleArn),
            new iam.ArnPrincipal(betaConfig.roles.cloudFormation.roleArn),
            new iam.ArnPrincipal(prodConfig.roles.codePipeline.roleArn),
            new iam.ArnPrincipal(prodConfig.roles.cloudFormation.roleArn),
          ],
          actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
          resources: ['*'],
        }),
      );

      // Comprehensive grants for all accounts
      [betaConfig, prodConfig].forEach((config) => {
        key.grant(
          config.principal,
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:Encrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
        );

        key.grant(
          config.roles.codePipeline,
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:Encrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
        );
      });

      return key;
    }

    private createArtifactBucket(
      scope: Stack,
      key: kms.Key,
      betaConfig: AccountConfig,
      prodConfig: AccountConfig,
    ): s3.Bucket {
      const artifactBucket = new s3.Bucket(scope, 'ArtifactBucket', {
        bucketName: `website-artifact-bucket-${scope.account}`,
        removalPolicy: RemovalPolicy.DESTROY,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        lifecycleRules: [
          {
            // Lifecycle rule to delete objects after 30 days
            expiration: Duration.days(30),
            noncurrentVersionExpiration: Duration.days(30),
          },
        ],
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Enhanced security
      });

      // Grant comprehensive bucket permissions to cross-account roles
      [betaConfig, prodConfig].forEach((config) => {
        artifactBucket.grantRead(config.roles.codePipeline);
        artifactBucket.grantRead(config.roles.cloudFormation);
        artifactBucket.grantReadWrite(config.principal);
      });

      // Add bucket policy for cross-account access
      artifactBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountBucketAccess',
          effect: iam.Effect.ALLOW,
          principals: [betaConfig.principal, prodConfig.principal],
          actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
          resources: [artifactBucket.bucketArn, `${artifactBucket.bucketArn}/*`],
        }),
      );

      return artifactBucket;
    }
  }

  /**
   * Manages build projects for the pipeline
   */
  export class BuildManager {
    public readonly cdkBuild: codebuild.PipelineProject;
    public readonly websiteBuild: codebuild.PipelineProject;
    public readonly betaCloudFrontInvalidation: codebuild.PipelineProject;
    public readonly prodCloudFrontInvalidation: codebuild.PipelineProject;

    constructor(scope: Stack, key: kms.Key, betaConfig: AccountConfig, prodConfig: AccountConfig) {
      this.cdkBuild = this.createCdkBuildProject(scope, key);
      this.websiteBuild = this.createWebsiteBuildProject(scope);
      this.betaCloudFrontInvalidation = this.createCloudFrontInvalidationProject(
        scope,
        'Beta',
        betaConfig.websiteConfig.distributionId,
        key,
        betaConfig.accountId, // Pass account ID
      );
      this.prodCloudFrontInvalidation = this.createCloudFrontInvalidationProject(
        scope,
        'Prod',
        prodConfig.websiteConfig.distributionId,
        key,
        prodConfig.accountId, // Pass account ID
      );
    }

    private createCdkBuildProject(scope: Stack, key: kms.Key): codebuild.PipelineProject {
      return new codebuild.PipelineProject(scope, 'CdkBuild', {
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: {
              'runtime-versions': {
                nodejs: 20,
              },
              commands: [
                'npm install', // Install dependencies
              ],
            },
            build: {
              commands: [
                'npm run build', // Compile TypeScript
                'npm run cdk synth -- -o dist', // Generate CloudFormation template
                'echo "Generated template files:"',
                'find dist -name "*.template.json" | sort', // List all template files for debugging
              ],
            },
          },
          artifacts: {
            'base-directory': 'dist',
            files: [
              '**/*.template.json', // Include all template files
            ],
          },
        }),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        },
        encryptionKey: key,
      });
    }

    private createWebsiteBuildProject(scope: Stack): codebuild.PipelineProject {
      return new codebuild.PipelineProject(scope, 'WebsiteBuild', {
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: {
              'runtime-versions': {
                nodejs: 20,
              },
              commands: ['npm install'],
            },
            build: {
              commands: ['npm run build'],
            },
          },
          artifacts: {
            'base-directory': 'dist',
            files: ['**/*'],
          },
        }),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        },
      });
    }

    private createCloudFrontInvalidationProject(
      scope: Stack,
      stageName: string,
      distributionId: string,
      key: kms.Key,
      accountId: string, // Add account ID parameter
    ): codebuild.PipelineProject {
      // Use a name that includes the account ID to ensure uniqueness
      const projectName = `${stageName}CloudFrontInvalidation-${accountId.substring(0, 6)}`;

      const project = new codebuild.PipelineProject(scope, projectName, {
        projectName: projectName, // Explicitly set project name for better visibility
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: {
              'runtime-versions': {
                nodejs: 20,
              },
            },
            build: {
              commands: [
                `echo "Starting CloudFront invalidation for ${stageName} environment - distribution ${distributionId}"`,
                `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*"`,
                `echo "CloudFront invalidation initiated for ${stageName.toLowerCase()} environment"`,
              ],
            },
          },
        }),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
          privileged: false, // No need for privileged mode for CloudFront invalidation
        },
        encryptionKey: key,
        description: `CodeBuild project to invalidate CloudFront cache for ${stageName} environment`,
        // Add environment variables for better debugging
        environmentVariables: {
          DISTRIBUTION_ID: {
            value: distributionId,
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          },
          STAGE_NAME: {
            value: stageName,
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          },
        },
        // Add timeout to prevent hanging builds
        timeout: Duration.minutes(10),
        // Add cache to speed up builds
        cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
      });

      // Add CloudFront invalidation permission to the project role
      project.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
          resources: [`arn:aws:cloudfront::${accountId}:distribution/${distributionId}`],
        }),
      );

      // Add permission to fetch stack outputs
      project.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudformation:DescribeStacks'],
          resources: [`arn:aws:cloudformation:${scope.region}:${accountId}:stack/*`],
        }),
      );

      // Add logging permissions
      project.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: ['*'],
        }),
      );

      return project;
    }
  }

  /**
   * Manages pipeline stages and actions
   */
  export class PipelineStageFactory {
    constructor(private readonly scope: Stack) {}

    /**
     * Creates the source stage
     */
    public createSourceStage(): codepipeline.StageProps {
      // Define pipeline stage output artifacts
      return {
        stageName: 'Source',
        actions: [
          new codepipeline_actions.GitHubSourceAction({
            actionName: 'GIDatingWebsite',
            owner: 'GardenInc',
            repo: 'GIDatingWebsite',
            oauthToken: SecretValue.secretsManager(SECRET_NAME),
            output: new codepipeline.Artifact('websiteCodeSource'),
            branch: 'main',
          }),
          new codepipeline_actions.GitHubSourceAction({
            actionName: 'GIDatingServiceCDK',
            owner: 'GardenInc',
            repo: 'GIDatingServiceCDK',
            oauthToken: SecretValue.secretsManager(SECRET_NAME),
            output: new codepipeline.Artifact('websiteCDKSource'),
            branch: 'main',
          }),
        ],
      };
    }

    /**
     * Creates the build stage
     */
    public createBuildStage(buildManager: BuildManager): codepipeline.StageProps {
      return {
        stageName: 'Build',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'CDK_Synth',
            project: buildManager.cdkBuild,
            input: new codepipeline.Artifact('websiteCDKSource'),
            outputs: [new codepipeline.Artifact('cdkBuildOutput')],
          }),
          new codepipeline_actions.CodeBuildAction({
            actionName: 'Website_Build',
            project: buildManager.websiteBuild,
            input: new codepipeline.Artifact('websiteCodeSource'),
            outputs: [new codepipeline.Artifact('websiteBuildOutput')],
          }),
        ],
      };
    }

    /**
     * Creates the pipeline update stage
     */
    public createPipelineUpdateStage(): codepipeline.StageProps {
      return {
        stageName: 'Pipeline_Update',
        actions: [
          new codepipeline_actions.CloudFormationCreateUpdateStackAction({
            actionName: 'SelfMutate',
            templatePath: new codepipeline.Artifact('cdkBuildOutput').atPath(
              `${WebsitePipelineStackName}${TEMPLATE_ENDING}`,
            ),
            stackName: `${WebsitePipelineStackName}`,
            adminPermissions: true,
            cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
          }),
        ],
      };
    }

    /**
     * Creates the beta deployment stage
     */
    public createBetaDeployStage(betaConfig: AccountConfig, buildManager: BuildManager): codepipeline.StageProps {
      return {
        stageName: 'Deploy_Beta',
        actions: [
          new codepipeline_actions.CloudFormationCreateUpdateStackAction({
            actionName: 'DeployWebsiteBucket',
            templatePath: new codepipeline.Artifact('cdkBuildOutput').atPath(
              `WebsiteBetaus-west-2BucketStack${TEMPLATE_ENDING}`,
            ),
            stackName: 'WebsiteBetaus-west-2BucketStack',
            adminPermissions: false,
            cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            role: betaConfig.roles.codePipeline,
            deploymentRole: betaConfig.roles.cloudFormation,
            runOrder: 1,
          }),
          // Deploy domain configuration for Beta
          new codepipeline_actions.CloudFormationCreateUpdateStackAction({
            actionName: 'DeployBetaDomainConfig',
            templatePath: new codepipeline.Artifact('cdkBuildOutput').atPath(
              `WebsiteBetaus-west-2Domainqandmedating-comStack${TEMPLATE_ENDING}`,
            ),
            stackName: 'WebsiteBetaus-west-2Domainqandmedating-comStack',
            adminPermissions: false,
            cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            role: betaConfig.roles.codePipeline,
            deploymentRole: betaConfig.roles.cloudFormation,
            runOrder: 2,
          }),
          // Improved S3 deployment with cache control
          new codepipeline_actions.S3DeployAction({
            actionName: 'DeployWebsiteContent',
            input: new codepipeline.Artifact('websiteBuildOutput'),
            bucket: s3.Bucket.fromBucketName(this.scope, 'WebsiteS3Bucket', betaConfig.websiteConfig.websiteBucketName),
            role: betaConfig.roles.codePipeline,
            runOrder: 3,
            cacheControl: [
              codepipeline_actions.CacheControl.setPublic(),
              codepipeline_actions.CacheControl.maxAge(Duration.days(7)),
              codepipeline_actions.CacheControl.sMaxAge(Duration.days(7)),
            ],
          }),
          // Invalidate CloudFront cache - Direct AWS CLI command instead of CodeBuild project
          new codepipeline_actions.CodeBuildAction({
            actionName: 'InvalidateCloudFrontCache',
            project: buildManager.betaCloudFrontInvalidation,
            input: new codepipeline.Artifact('websiteBuildOutput'),
            runOrder: 4,
            role: betaConfig.roles.codePipeline,
          }),
        ],
      };
    }

    /**
     * Creates the approval stage
     */
    public createApprovalStage(betaConfig: AccountConfig): codepipeline.StageProps {
      return {
        stageName: 'Manual_Approval',
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve',
            additionalInformation: 'Approve deployment to production environment',
            externalEntityLink: `https://beta.${betaConfig.websiteConfig.config.domainName ?? 'qandmedating.com'}`,
          }),
        ],
      };
    }

    /**
     * Creates the production deployment stage
     */
    public createProdDeployStage(prodConfig: AccountConfig, buildManager: BuildManager): codepipeline.StageProps {
      return {
        stageName: 'Deploy_Prod',
        actions: [
          new codepipeline_actions.CloudFormationCreateUpdateStackAction({
            actionName: 'DeployWebsiteBucket',
            templatePath: new codepipeline.Artifact('cdkBuildOutput').atPath(
              `WebsiteProdus-west-2BucketStack${TEMPLATE_ENDING}`,
            ),
            stackName: 'WebsiteProdus-west-2BucketStack',
            adminPermissions: false,
            cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            role: prodConfig.roles.codePipeline,
            deploymentRole: prodConfig.roles.cloudFormation,
            runOrder: 1,
          }),
          // Deploy domain configuration for Prod
          new codepipeline_actions.CloudFormationCreateUpdateStackAction({
            actionName: 'DeployProdDomainConfig',
            templatePath: new codepipeline.Artifact('cdkBuildOutput').atPath(
              `WebsiteProdus-west-2Domainqandmedating-comStack${TEMPLATE_ENDING}`,
            ),
            stackName: 'WebsiteProdus-west-2Domainqandmedating-comStack',
            adminPermissions: false,
            cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            role: prodConfig.roles.codePipeline,
            deploymentRole: prodConfig.roles.cloudFormation,
            runOrder: 2,
          }),
          // Improved S3 deployment with cache control
          new codepipeline_actions.S3DeployAction({
            actionName: 'DeployWebsiteContent',
            input: new codepipeline.Artifact('websiteBuildOutput'),
            bucket: s3.Bucket.fromBucketAttributes(this.scope, 'ProdWebsiteS3Bucket', {
              bucketArn: prodConfig.websiteConfig.websiteBucketArn,
            }),
            role: prodConfig.roles.codePipeline,
            runOrder: 3,
            cacheControl: [
              codepipeline_actions.CacheControl.setPublic(),
              codepipeline_actions.CacheControl.maxAge(Duration.days(30)),
              codepipeline_actions.CacheControl.sMaxAge(Duration.days(30)),
            ],
          }),
          // Invalidate CloudFront cache - Direct AWS CLI command instead of CodeBuild project
          new codepipeline_actions.CodeBuildAction({
            actionName: 'InvalidateCloudFrontCache',
            project: buildManager.prodCloudFrontInvalidation,
            input: new codepipeline.Artifact('websiteBuildOutput'),
            runOrder: 4,
            role: prodConfig.roles.codePipeline,
          }),
        ],
      };
    }
  }

  /**
   * Manages outputs and permissions
   */
  export class OutputManager {
    constructor(private readonly scope: Stack) {}

    /**
     * Creates stack outputs
     */
    public createOutputs(securityManager: SecurityManager, betaConfig: AccountConfig, prodConfig: AccountConfig): void {
      // Key and bucket outputs
      new CfnOutput(this.scope, 'WebsiteArtifactBucketEncryptionKeyArn', {
        value: securityManager.key.keyArn,
        exportName: 'WebsiteArtifactBucketEncryptionKey',
        description: 'The ARN of the KMS key used to encrypt artifacts for the Website pipeline',
      });

      new CfnOutput(this.scope, 'WebsiteArtifactBucketArn', {
        value: securityManager.artifactBucket.bucketArn,
        exportName: 'WebsiteArtifactBucketArn',
        description: 'The ARN of the S3 bucket used to store artifacts for the Website pipeline',
      });

      // Environment specific outputs
      // Beta environment
      new CfnOutput(this.scope, 'BetaWebsiteUrl', {
        value: `https://beta.${betaConfig.websiteConfig.config.domainName ?? 'qandmedating.com'}`,
        description: 'The URL of the Beta website',
      });

      new CfnOutput(this.scope, 'BetaInvalidationCommand', {
        value: `aws cloudfront create-invalidation --distribution-id ${betaConfig.websiteConfig.distributionId} --paths "/*"`,
        description: 'Command to manually invalidate the Beta CloudFront distribution',
      });

      // Production environment
      new CfnOutput(this.scope, 'ProdWebsiteUrl', {
        value: `https://${prodConfig.websiteConfig.config.domainName ?? 'qandmedating.com'}`,
        description: 'The URL of the Production website',
      });

      new CfnOutput(this.scope, 'ProdInvalidationCommand', {
        value: `aws cloudfront create-invalidation --distribution-id ${prodConfig.websiteConfig.distributionId} --paths "/*"`,
        description: 'Command to manually invalidate the Production CloudFront distribution',
      });
    }

    /**
     * Configures pipeline permissions
     */
    public configurePipelinePermissions(
      pipeline: codepipeline.Pipeline,
      securityManager: SecurityManager,
      betaConfig: AccountConfig,
      prodConfig: AccountConfig,
    ): void {
      // Add target accounts to the pipeline policy
      pipeline.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${betaConfig.websiteConfig.config.accountId}:role/*`,
            `arn:aws:iam::${prodConfig.websiteConfig.config.accountId}:role/*`,
          ],
        }),
      );

      // Allow Pipeline to read key from secrets manager
      pipeline.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:us-west-2:${pipelineAccountId}:secret:github-token-secret-t1s1c5`],
        }),
      );

      // Allow pipeline to self mutate
      pipeline.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameters'],
          resources: [`arn:aws:ssm:us-west-2:${pipelineAccountId}:parameter/*`],
        }),
      );

      // Allow pipeline role to use the KMS key
      pipeline.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
          resources: [securityManager.key.keyArn],
        }),
      );

      // Add CloudFront invalidation permissions
      pipeline.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${betaConfig.websiteConfig.config.accountId}:distribution/${betaConfig.websiteConfig.distributionId}`,
            `arn:aws:cloudfront::${prodConfig.websiteConfig.config.accountId}:distribution/${prodConfig.websiteConfig.distributionId}`,
          ],
        }),
      );
    }
  }
}

export class WebsitePipelineStack extends Stack {
  constructor(app: App, id: string, props: WebsitePipelineStackProps) {
    super(app, id, props);

    // Extract configurations
    const betaConfig = props.stacksToDeploy[0];
    const prodConfig = props.stacksToDeploy[1];

    // Setup account configurations
    const betaAccountConfig: PipelineComponents.AccountConfig = {
      accountId: betaConfig.config.accountId,
      roles: {
        cloudFormation: iam.Role.fromRoleArn(
          this,
          'BetaDeploymentRole',
          `arn:aws:iam::${betaConfig.config.accountId}:role/CloudFormationDeploymentRole`,
          { mutable: false },
        ),
        codePipeline: iam.Role.fromRoleArn(
          this,
          'BetaCrossAccountRole',
          `arn:aws:iam::${betaConfig.config.accountId}:role/CodePipelineCrossAccountRole`,
          { mutable: false },
        ),
      },
      principal: new iam.AccountPrincipal(betaConfig.config.accountId),
      websiteConfig: betaConfig,
    };

    const prodAccountConfig: PipelineComponents.AccountConfig = {
      accountId: prodConfig.config.accountId,
      roles: {
        cloudFormation: iam.Role.fromRoleArn(
          this,
          'ProdDeploymentRole',
          `arn:aws:iam::${prodConfig.config.accountId}:role/CloudFormationDeploymentRole`,
          { mutable: false },
        ),
        codePipeline: iam.Role.fromRoleArn(
          this,
          'ProdCrossAccountRole',
          `arn:aws:iam::${prodConfig.config.accountId}:role/CodePipelineCrossAccountRole`,
          { mutable: false },
        ),
      },
      principal: new iam.AccountPrincipal(prodConfig.config.accountId),
      websiteConfig: prodConfig,
    };

    // Create security resources
    const securityManager = new PipelineComponents.SecurityManager(this, betaAccountConfig, prodAccountConfig);

    // Create build projects
    const buildManager = new PipelineComponents.BuildManager(
      this,
      securityManager.key,
      betaAccountConfig,
      prodAccountConfig,
    );

    // Create pipeline stage factory
    const stageFactory = new PipelineComponents.PipelineStageFactory(this);

    // Create the pipeline with stages
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'WebsiteCrossAccountPipeline',
      crossRegionReplicationBuckets: {
        'us-west-2': securityManager.artifactBucket,
      },
      crossAccountKeys: true,
      stages: [
        stageFactory.createSourceStage(),
        stageFactory.createBuildStage(buildManager),
        stageFactory.createPipelineUpdateStage(),
        stageFactory.createBetaDeployStage(betaAccountConfig, buildManager),
        stageFactory.createApprovalStage(betaAccountConfig),
        stageFactory.createProdDeployStage(prodAccountConfig, buildManager),
      ],
    });

    // Configure outputs and permissions
    const outputManager = new PipelineComponents.OutputManager(this);
    outputManager.createOutputs(securityManager, betaAccountConfig, prodAccountConfig);
    outputManager.configurePipelinePermissions(pipeline, securityManager, betaAccountConfig, prodAccountConfig);
  }
}
