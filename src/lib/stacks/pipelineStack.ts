import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities, SecretValue } from 'aws-cdk-lib';
import { ApplicationStackConfigInterface } from '../utils/config';
import { secretName } from '../utils/constants';

export interface PipelineStackProps extends StackProps {
  readonly applicationStackConfigs: ApplicationStackConfigInterface[];
}

export class PipelineStack extends Stack {
  constructor(app: App, id: string, props: PipelineStackProps) {
    super(app, id, props);

    const betaConfig = props.applicationStackConfigs[0];
    const betaAccountId = betaConfig.config.accountId;
    const prodConfig = props.applicationStackConfigs[1];
    const prodAccountId = prodConfig.config.accountId;

    // Add update pipeline stage
    // Add manual approval between beta and prod

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
      alias: 'key/pipeline-artifact-key',
    });
    key.grantDecrypt(betaAccountRootPrincipal);
    key.grantDecrypt(betaCodePipelineRole);
    key.grantDecrypt(prodAccountRootPrincipal);
    key.grantDecrypt(prodCodeDeployRole);

    // Create S3 bucket with target account cross-account access
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `artifact-bucket-${this.account}`,
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
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
          'base-directory': 'build/cdkOut',
          files: ['*us-west-2.template.json'],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
      // use the encryption key for build artifacts
      encryptionKey: key,
    });

    // Lambda build definition
    const lambdaBuild = new codebuild.PipelineProject(this, 'LambdaBuild', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 20,
            },
            commands: ['cd app', 'npm install'],
          },
          build: {
            commands: 'npm run build',
          },
        },
        artifacts: {
          'base-directory': 'app',
          files: ['index.js', 'node_modules/**/*'],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
      },
      // use the encryption key for build artifacts
      encryptionKey: key,
    });

    // Define pipeline stage output artifacts
    const sourceOutput = new codepipeline.Artifact();
    const cdkBuildOutput = new codepipeline.Artifact('CdkBuildOutput');
    const lambdaBuildOutput = new codepipeline.Artifact('LambdaBuildOutput');

    // Pipeline definition
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'CrossAccountPipeline',
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GitHub_Source',
              owner: 'GardenInc',
              repo: 'GIDatingServiceCDK',
              oauthToken: SecretValue.secretsManager(secretName),
              output: sourceOutput,
              branch: 'main',
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Application_Build',
              project: lambdaBuild,
              input: sourceOutput,
              outputs: [lambdaBuildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CDK_Synth',
              project: cdkBuild,
              input: sourceOutput,
              outputs: [cdkBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy_Beta',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'Deploy',
              templatePath: cdkBuildOutput.atPath('build/cdk.out/betaServiceStackus-west-2'),
              stackName: 'betaServiceStackus-west-2',
              adminPermissions: false,
              parameterOverrides: {
                ...betaConfig.stack.lambdaCode.assign(lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: betaCodePipelineRole,
              deploymentRole: betaCloudFormationRole,
            }),
          ],
        },
        {
          stageName: 'Deploy_Prod',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'Deploy',
              templatePath: cdkBuildOutput.atPath('build/cdk.out/prodServiceStackus-west-2.template.json'),
              stackName: 'prodServiceStackus-west-2',
              adminPermissions: false,
              parameterOverrides: {
                ...prodConfig.stack.lambdaCode.assign(lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
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
        resources: [`arn:aws:secretsmanager:us-west-2:682033486425:secret:github-token-secret-t1s1c5`],
      }),
    );

    // Publish the KMS Key ARN as an output
    new CfnOutput(this, 'ArtifactBucketEncryptionKeyArn', {
      value: key.keyArn,
      exportName: 'ArtifactBucketEncryptionKey',
    });
  }
}
