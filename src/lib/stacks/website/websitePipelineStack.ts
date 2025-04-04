import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities, SecretValue } from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import { WebsiteStackConfigInterface } from '../../utils/config'; // You'll need to create this interface
import { SECRET_NAME, WebsitePipelineStackName, TEMPLATE_ENDING, WEBSITE_BUCKET_STACK } from '../../utils/constants'; // You'll need to add these constants
import { pipelineAccountId } from '../../utils/accounts';

export interface WebsitePipelineStackProps extends StackProps {
  readonly stacksToDeploy: WebsiteStackConfigInterface[];
}

export class WebsitePipelineStack extends Stack {
  constructor(app: App, id: string, props: WebsitePipelineStackProps) {
    super(app, id, props);

    const betaConfig = props.stacksToDeploy[0];
    const betaAccountId = betaConfig.config.accountId;
    const prodConfig = props.stacksToDeploy[1];
    const prodAccountId = prodConfig.config.accountId;

    // Resolve ARNs of cross-account roles for the Beta account
    const betaCloudFormationRole = iam.Role.fromRoleArn(
      this,
      'BetaDeploymentRole',
      `arn:aws:iam::${betaAccountId}:role/CloudFormationDeploymentRole`,
      {
        mutable: false,
      },
    );
    const betaCodePipelineRole = iam.Role.fromRoleArn(
      this,
      'BetaCrossAccountRole',
      `arn:aws:iam::${betaAccountId}:role/CodePipelineCrossAccountRole`,
      {
        mutable: false,
      },
    );

    // Resolve ARNS of cross-account roles for the Prod account
    const prodCloudFormationRole = iam.Role.fromRoleArn(
      this,
      'ProdDeploymentRole',
      `arn:aws:iam::${prodAccountId}:role/CloudFormationDeploymentRole`,
      {
        mutable: false,
      },
    );
    const prodCodeDeployRole = iam.Role.fromRoleArn(
      this,
      'ProdCrossAccountRole',
      `arn:aws:iam::${prodAccountId}:role/CodePipelineCrossAccountRole`,
      {
        mutable: false,
      },
    );

    // Resolve root Principal ARNs for both deployment accounts
    const betaAccountRootPrincipal = new iam.AccountPrincipal(betaAccountId);
    const prodAccountRootPrincipal = new iam.AccountPrincipal(prodAccountId);

    // Create KMS key and update policy with cross-account access
    const key = new kms.Key(this, 'ArtifactKey', {
      alias: 'key/website-pipeline-artifact-key',
    });
    key.grantDecrypt(betaAccountRootPrincipal);
    key.grantDecrypt(betaCodePipelineRole);
    key.grantDecrypt(prodAccountRootPrincipal);
    key.grantDecrypt(prodCodeDeployRole);

    // Create S3 bucket with target account cross-account access
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `website-artifact-bucket-${this.account}`,
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
    });
    artifactBucket.grantPut(betaAccountRootPrincipal);
    artifactBucket.grantRead(betaAccountRootPrincipal);
    artifactBucket.grantPut(prodAccountRootPrincipal);
    artifactBucket.grantRead(prodAccountRootPrincipal);

    // CDK build definition
    const cdkBuild = new codebuild.PipelineProject(this, 'CdkBuild', {
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
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: [`${WebsitePipelineStackName}${TEMPLATE_ENDING}`, `*${WEBSITE_BUCKET_STACK}${TEMPLATE_ENDING}`],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
      encryptionKey: key,
    });

    // Website build definition with asset handling
    const websiteBuild = new codebuild.PipelineProject(this, 'WebsiteBuild', {
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
          pre_build: {
            commands: [
              // Create a custom Vite config that correctly handles asset imports
              'echo "Creating custom vite config"',
              'cat > vite.config.js << EOL',
              'import { defineConfig } from "vite"',
              'import react from "@vitejs/plugin-react"',
              'import { resolve } from "path"',
              '',
              'export default defineConfig({',
              '  plugins: [react()],',
              '  build: {',
              '    outDir: "build",',
              '  },',
              '  resolve: {',
              '    alias: {',
              '      "@assets": resolve(__dirname, "src/assets")',
              '    }',
              '  }',
              '})',
              'EOL',
              // Create alias module to make imports work
              'mkdir -p node_modules/@assets',
              'echo "export * from \'../src/assets\';" > node_modules/@assets/index.js',
              'cp -r src/assets/* node_modules/@assets/',
            ],
          },
          build: {
            commands: [
              'npm run build', // Build the website
              // Ensure assets get into the final build
              'mkdir -p build/assets',
              'cp -r src/assets/* build/assets/ || echo "No assets to copy"',
            ],
          },
        },
        artifacts: {
          'base-directory': 'build',
          files: ['**/*'],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        privileged: true,
      },
      encryptionKey: key,
    });

    // Define pipeline stage output artifacts
    const cdkSource = new codepipeline.Artifact('websiteCDKSource');
    const websiteSource = new codepipeline.Artifact('websiteCodeSource');
    const websiteBuildOutput = new codepipeline.Artifact('websiteBuildOutput');
    const cdkBuildOutput = new codepipeline.Artifact('cdkBuildOutput');

    // Pipeline definition
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'WebsiteCrossAccountPipeline',
      crossRegionReplicationBuckets: {
        'us-west-2': artifactBucket,
      },
      crossAccountKeys: true,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GIDatingWebsite',
              owner: 'GardenInc',
              repo: 'GIDatingWebsite',
              oauthToken: SecretValue.secretsManager(SECRET_NAME),
              output: websiteSource,
              branch: 'main',
            }),
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GIDatingServiceCDK',
              owner: 'GardenInc',
              repo: 'GIDatingServiceCDK',
              oauthToken: SecretValue.secretsManager(SECRET_NAME),
              output: cdkSource,
              branch: 'main',
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CDK_Synth',
              project: cdkBuild,
              input: cdkSource,
              outputs: [cdkBuildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Website_Build',
              project: websiteBuild,
              input: websiteSource,
              outputs: [websiteBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Pipeline_Update',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'SelfMutate',
              templatePath: cdkBuildOutput.atPath(`${WebsitePipelineStackName}${TEMPLATE_ENDING}`),
              stackName: `${WebsitePipelineStackName}`,
              adminPermissions: true,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            }),
          ],
        },
        {
          stageName: 'Deploy_Beta',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'DeployWebsiteBucket',
              templatePath: cdkBuildOutput.atPath(`WebsiteBetauswest2BucketStack${TEMPLATE_ENDING}`),
              stackName: 'WebsiteBetauswest2BucketStack',
              adminPermissions: false,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: betaCodePipelineRole,
              deploymentRole: betaCloudFormationRole,
              runOrder: 1,
            }),
            new codepipeline_actions.S3DeployAction({
              actionName: 'DeployWebsiteContent',
              input: websiteBuildOutput,
              bucket: s3.Bucket.fromBucketName(this, 'WebsiteS3Bucket', betaConfig.websiteBucketName),
              role: betaCodePipelineRole,
              runOrder: 2,
            }),
            // Add a step to invalidate CloudFront cache
            new codepipeline_actions.CodeBuildAction({
              actionName: 'InvalidateCloudFrontCache',
              project: new codebuild.PipelineProject(this, 'CloudFrontInvalidation', {
                buildSpec: codebuild.BuildSpec.fromObject({
                  version: '0.2',
                  phases: {
                    build: {
                      commands: [
                        // Use the string value, not a resource reference
                        `aws cloudfront create-invalidation --distribution-id ${betaConfig.distributionId} --paths "/*"`,
                      ],
                    },
                  },
                }),
                environment: {
                  buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
                },
              }),
              input: websiteBuildOutput,
              runOrder: 3,
            }),
          ],
        },
        {
          stageName: 'Manual_Approval',
          actions: [
            new codepipeline_actions.ManualApprovalAction({
              actionName: 'Approve',
            }),
          ],
        },
        {
          stageName: 'Deploy_Prod',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'DeployWebsiteBucket',
              templatePath: cdkBuildOutput.atPath(`WebsiteProduswest2BucketStack${TEMPLATE_ENDING}`),
              stackName: 'WebsiteProduswest2BucketStack',
              adminPermissions: false,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: prodCodeDeployRole,
              deploymentRole: prodCloudFormationRole,
              runOrder: 1,
            }),
            new codepipeline_actions.S3DeployAction({
              actionName: 'DeployWebsiteContent',
              input: websiteBuildOutput,
              bucket: s3.Bucket.fromBucketAttributes(this, 'ProdWebsiteS3Bucket', {
                bucketArn: prodConfig.websiteBucketArn, // You'll need to pass this from the website bucket stack
              }),
              role: prodCodeDeployRole,
              runOrder: 2,
            }),
            // Add a step to invalidate CloudFront cache for prod
            new codepipeline_actions.CodeBuildAction({
              actionName: 'InvalidateCloudFrontCache',
              project: new codebuild.PipelineProject(this, 'ProdCloudFrontInvalidation', {
                buildSpec: codebuild.BuildSpec.fromObject({
                  version: '0.2',
                  phases: {
                    build: {
                      commands: [
                        'aws cloudfront create-invalidation --distribution-id ' +
                          prodConfig.distributionId +
                          ' --paths "/*"',
                      ],
                    },
                  },
                }),
                environment: {
                  buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
                },
              }),
              input: websiteBuildOutput, // Just needs some input artifact
              runOrder: 3,
              role: prodCodeDeployRole,
            }),
          ],
        },
      ],
    });

    // Add the target accounts to the pipeline policy
    pipeline.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${betaAccountId}:role/*`, `arn:aws:iam::${prodAccountId}:role/*`],
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

    // Publish the KMS Key ARN as an output
    new CfnOutput(this, 'WebsiteArtifactBucketEncryptionKeyArn', {
      value: key.keyArn,
      exportName: 'WebsiteArtifactBucketEncryptionKey',
    });
  }
}
