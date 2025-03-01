import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { App, Stack, StackProps, RemovalPolicy, CfnOutput, CfnCapabilities, SecretValue } from 'aws-cdk-lib';
import { ApplicationStackConfigInterface } from '../../utils/config';
import {
  SECRET_NAME,
  BackendPipelineStackName,
  TEMPLATE_ENDING,
  SERVICE_STACK,
  VPC_STACK,
} from '../../utils/constants';
import { Duration } from 'aws-cdk-lib';
import { pipelineAccountId } from '../../utils/accounts';
import { ApplicationStack } from './applicationStack';

export interface BackendPipelineStackProps extends StackProps {
  readonly stacksToDeploy: ApplicationStackConfigInterface[];
}

export class BackendPipelineStack extends Stack {
  constructor(app: App, id: string, props: BackendPipelineStackProps) {
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
          files: [
            `*${SERVICE_STACK}${TEMPLATE_ENDING}`,
            `${BackendPipelineStackName}${TEMPLATE_ENDING}`,
            `*${VPC_STACK}${TEMPLATE_ENDING}`,
          ],
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
    const cdksource = new codepipeline.Artifact('backendSource');
    const cdkBuildOutput = new codepipeline.Artifact('backendCDKBuildOutput');
    const lambdaBuildOutput = new codepipeline.Artifact('backendLambdaBuildOutput');

    // Application Stack
    const betaApplicationStack: ApplicationStack = betaConfig.stacks.applicationStack;
    const prodApplicationStack: ApplicationStack = prodConfig.stacks.applicationStack;

    // Pipeline definition
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'BackendCrossAccountPipeline',
      artifactBucket: artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.GitHubSourceAction({
              actionName: 'GitHub_Source',
              owner: 'GardenInc',
              repo: 'GIDatingServiceCDK',
              oauthToken: SecretValue.secretsManager(SECRET_NAME),
              output: cdksource,
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
              input: cdksource,
              outputs: [lambdaBuildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'CDK_Synth',
              project: cdkBuild,
              input: cdksource,
              outputs: [cdkBuildOutput],
            }),
          ],
        },
        {
          stageName: 'Pipeline_Update',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'SelfMutate',
              templatePath: cdkBuildOutput.atPath(`${BackendPipelineStackName}${TEMPLATE_ENDING}`),
              stackName: `${BackendPipelineStackName}`,
              adminPermissions: true,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
            }),
          ],
        },
        {
          stageName: 'Deploy_Beta',
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'DeployServiceStack',
              templatePath: cdkBuildOutput.atPath(`Betauswest2ServiceStack${TEMPLATE_ENDING}`),
              stackName: 'Betauswest2ServiceStack',
              adminPermissions: false,
              parameterOverrides: {
                ...betaApplicationStack.lambdaCode.assign(lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: betaCodePipelineRole,
              deploymentRole: betaCloudFormationRole,
              runOrder: 2,
            }),
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'DeployVpcStack',
              templatePath: cdkBuildOutput.atPath(`BackEndBetauswest2VpcStack${TEMPLATE_ENDING}`),
              stackName: 'BackEndBetauswest2VpcStack',
              adminPermissions: false,
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: betaCodePipelineRole,
              deploymentRole: betaCloudFormationRole,
              runOrder: 1,
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
              actionName: 'DeployServiceStack',
              templatePath: cdkBuildOutput.atPath(`Produswest2ServiceStack${TEMPLATE_ENDING}`),
              stackName: 'Produswest2ServiceStack',
              adminPermissions: false,
              parameterOverrides: {
                ...prodApplicationStack.lambdaCode.assign(lambdaBuildOutput.s3Location),
              },
              extraInputs: [lambdaBuildOutput],
              cfnCapabilities: [CfnCapabilities.ANONYMOUS_IAM],
              role: prodCodeDeployRole,
              deploymentRole: prodCloudFormationRole,
            }),
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: 'DeployVpcStack',
              templatePath: cdkBuildOutput.atPath(`BackEndProduswest2VpcStack${TEMPLATE_ENDING}`),
              stackName: 'BackEndProduswest2VpcStack',
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
    new CfnOutput(this, 'ArtifactBucketEncryptionKeyArn', {
      value: key.keyArn,
      exportName: 'ArtifactBucketEncryptionKey',
    });
  }
}
