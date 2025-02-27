import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities, SecretValue } from 'aws-cdk-lib';
import { FrontEndStackConfigInterface } from '../../utils/config';
import { SECRET_NAME, FrontendPipelineStackName, TEMPLATE_ENDING, DEVICE_FARM_STACK } from '../../utils/constants';
import { pipelineAccountId } from '../../utils/accounts';
import { Duration } from 'aws-cdk-lib';

export interface FrontendPipelineStackProps extends StackProps {
  readonly stacksToDeploy: FrontEndStackConfigInterface[];
}

export class FrontendPipelineStack extends Stack {
  constructor(app: App, id: string, props: FrontendPipelineStackProps) {
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
      alias: 'key/frontend-pipeline-artifact-key',
    });
    key.grantDecrypt(betaAccountRootPrincipal);
    key.grantDecrypt(betaCodePipelineRole);
    key.grantDecrypt(prodAccountRootPrincipal);
    key.grantDecrypt(prodCodeDeployRole);

    // Create S3 bucket with target account cross-account access
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `frontend-artifact-bucket-${this.account}`,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      lifecycleRules: [
        {
          // Lifecycle rule to delete objects after 30 days
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(30), // Optional, to delete noncurrent versions
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
          files: [`${FrontendPipelineStackName}${TEMPLATE_ENDING}`, `*${DEVICE_FARM_STACK}${TEMPLATE_ENDING}`],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
      // use the encryption key for build artifacts
      encryptionKey: key,
    });

    // CDK build definition
    const frontEndBuild = new codebuild.PipelineProject(this, 'FrontEndBuild', {
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
              'npx expo prebuild', // builds android and ios files
            ],
          },
        },
        artifacts: {
          files: [`android/**/*`, `ios/**/*`],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
      // use the encryption key for build artifacts
      encryptionKey: key,
    });

    // CDK build definition
    const androidBuild = new codebuild.PipelineProject(this, 'androidBuild', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'cd android', // Move into android folders
            ],
          },
          build: {
            commands: [
              './gradlew assembleDebug', // builds the debug files
            ],
          },
        },
        artifacts: {
          files: [`app/build/outputs/apk/debug/**/*`],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
      // use the encryption key for build artifacts
      encryptionKey: key,
    });

    // Define pipeline stage output artifacts
    const cdkSource = new codepipeline.Artifact('frontEndSourceCDK');
    const frontendUXsource = new codepipeline.Artifact('frontEndSourceUX');
    const frontEndUXOutput = new codepipeline.Artifact('frontEndUXCodeBuild');
    const cdkBuildOutput = new codepipeline.Artifact('frontEndCDKBuildOutput');
    const androidBuildOutput = new codepipeline.Artifact('androidAPKOutput');
    const iosBuildOutput = new codepipeline.Artifact('iosIPAOutput');

    // Pipeline definition
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'FrontEndCrossAccountPipeline',
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GIDatingFrontend',
              owner: 'GardenInc',
              repo: 'GIDatingFrontend',
              oauthToken: SecretValue.secretsManager(SECRET_NAME),
              output: frontendUXsource,
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
          stageName: 'Initial_Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CDK_Synth',
              project: cdkBuild,
              input: cdkSource,
              outputs: [cdkBuildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'FrontEnd_Build',
              project: frontEndBuild,
              input: frontendUXsource,
              outputs: [frontEndUXOutput],
            }),
          ],
        },
        {
          stageName: 'Pipeline_Update',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'SelfMutate',
              templatePath: cdkBuildOutput.atPath(`${FrontendPipelineStackName}${TEMPLATE_ENDING}`),
              stackName: `${FrontendPipelineStackName}`,
              adminPermissions: true,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            }),
          ],
        },
        {
          stageName: 'APK_and_IOS_Builds',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'APK_Build',
              project: androidBuild,
              input: frontendUXsource,
              outputs: [androidBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy_Beta',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'DeployDeviceFarmStack',
              templatePath: cdkBuildOutput.atPath(`Betauswest2DeviceFarmStack${TEMPLATE_ENDING}`),
              stackName: 'Betauswest2DeviceFarmStack',
              adminPermissions: false,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: betaCodePipelineRole,
              deploymentRole: betaCloudFormationRole,
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
              actionName: 'DeployDeviceFarmStack',
              templatePath: cdkBuildOutput.atPath(`Produswest2DeviceFarmStack${TEMPLATE_ENDING}`),
              stackName: 'Produswest2DeviceFarmStack',
              adminPermissions: false,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: prodCodeDeployRole,
              deploymentRole: prodCloudFormationRole,
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
    new CfnOutput(this, 'FrontEndArtifactBucketEncryptionKeyArn', {
      value: key.keyArn,
      exportName: 'FrontEndArtifactBucketEncryptionKey',
    });
  }
}
