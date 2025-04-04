#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from './stacks/backend/applicationStack';
import { BackendPipelineStack, BackendPipelineStackProps } from './stacks/backend/backendPipelineStack';
import { FrontendPipelineStackProps, FrontendPipelineStack } from './stacks/frontend/frontendPipelineStack';
import { WebsitePipelineStackProps, WebsitePipelineStack } from './stacks/website/websitePipelineStack';
import { DeviceFarmStackProps, DeviceFarmStack } from './stacks/frontend/deviceFarmStack';
import {
  WebsiteDeploymentBucketStackProps,
  WebsiteDeploymentBucketStack,
} from './stacks/website/websiteDeploymentBucketStack';
import { DomainConfigurationStack, DomainConfigurationStackProps } from './stacks/website/domainConfigurationStack';
import { stageConfigurationList } from './utils/config';
import {
  FrontEndStackConfigInterface,
  ApplicationStackConfigInterface,
  WebsiteStackConfigInterface,
} from './utils/config';
import { ApplicationStackProps } from './stacks/backend/applicationStack';
import { VpcStackProps, VpcStack } from './stacks/backend/vpcStack';
import {
  BackendPipelineStackName,
  FrontendPipelineStackName,
  WebsitePipelineStackName,
  FRONT_END,
  BACK_END,
  WEBSITE,
  DOMAIN_NAME,
} from './utils/constants';
import {
  createServiceStackName,
  createVpcStackName,
  createDeviceFarmStackName,
  createDeploymentBucketStackName,
  createWebsiteBucketStackName,
  createDomainConfigStackName,
} from './utils/utils';
import { DeploymentBucketStackProps, DeploymentBucketStack } from './stacks/frontend/deploymentBucketStack';

const app = new cdk.App();

// Setup a stack of applications which will be deployed to the pipeline
const backendServiceStackList: ApplicationStackConfigInterface[] = [];
const frontendServiceStackList: FrontEndStackConfigInterface[] = [];
const websiteServiceStackList: WebsiteStackConfigInterface[] = [];

// Create website configuration first with generated values
for (var stageConfig of stageConfigurationList) {
  // Generate the same bucket name pattern as in WebsiteDeploymentBucketStack
  const bucketNamePrefix = `website-${stageConfig.stage.toLowerCase()}-${stageConfig.accountId}`;
  const uniqueBucketName = `${bucketNamePrefix}-${stageConfig.region}`;

  // Create configuration with dummy CloudFront values
  const websiteStageConfigurationList: WebsiteStackConfigInterface = {
    config: stageConfig,
    websiteBucketArn: `arn:aws:s3:::${uniqueBucketName}`,
    websiteBucketName: uniqueBucketName,
    // For initial deployment, use dummy values that will be replaced after first deployment
    distributionId: `dummy-distribution-id-${stageConfig.stage.toLowerCase()}`,
    distributionDomainName: `dummy-domain-${stageConfig.stage.toLowerCase()}.cloudfront.net`,
  };

  websiteServiceStackList.push(websiteStageConfigurationList);
}

// Now deploy all the actual stacks
for (var stageConfig of stageConfigurationList) {
  /*
   --- Website Stacks ---
   */
  const websiteBucketStackProps: WebsiteDeploymentBucketStackProps = {
    stageName: stageConfig.stage,
    env: {
      account: stageConfig.accountId,
      region: stageConfig.region,
    },
  };

  const websiteBucketStackName: string = createWebsiteBucketStackName(stageConfig.stage, stageConfig.region, WEBSITE);
  new WebsiteDeploymentBucketStack(app, websiteBucketStackName, websiteBucketStackProps);

  // Create the domain configuration stack for both beta and prod
  // We'll create the domain config for both environments to properly handle Route53
  const bucketNamePrefix = `website-${stageConfig.stage.toLowerCase()}-${stageConfig.accountId}`;
  const bucketName = `${bucketNamePrefix}-${stageConfig.region}`;

  const domainConfigStackProps: DomainConfigurationStackProps = {
    stageName: stageConfig.stage,
    domainName: DOMAIN_NAME,
    bucketName: bucketName,
    env: {
      account: stageConfig.accountId,
      region: stageConfig.region,
    },
  };

  const domainConfigStackName: string = createDomainConfigStackName(
    stageConfig.stage,
    stageConfig.region,
    WEBSITE,
    DOMAIN_NAME.replace(/\./g, '-'),
  );

  // Only create domain config for Beta initially
  // For production, we'll set up the domain after beta is confirmed working
  if (stageConfig.stage.toLowerCase() === 'beta') {
    new DomainConfigurationStack(app, domainConfigStackName, domainConfigStackProps);
  }
}

// Now deploy the rest of the stacks
for (var stageConfig of stageConfigurationList) {
  /*
   --- Front End Stacks ---
   */
  // Deployment bucket
  const deploymentBucketStackProps: DeploymentBucketStackProps = {
    stageName: stageConfig.stage,
  };
  const deploymentBucketStackName: string = createDeploymentBucketStackName(
    stageConfig.stage,
    stageConfig.region,
    FRONT_END,
  );
  const deploymentBucketStack = new DeploymentBucketStack(app, deploymentBucketStackName, deploymentBucketStackProps);

  // Device Farm Stack
  const deviceFarmStackProps: DeviceFarmStackProps = {
    stageName: stageConfig.stage,
    frontEndBuildBucketArn: deploymentBucketStack.bucketArn,
  };
  const deviceFarmStackName: string = createDeviceFarmStackName(stageConfig.stage, stageConfig.region, FRONT_END);
  new DeviceFarmStack(app, deviceFarmStackName, deviceFarmStackProps);

  const frontendStageConfigurationList: FrontEndStackConfigInterface = {
    config: stageConfig,
    frontEndCodeDeploymentBucketArn: deploymentBucketStack.bucketArn,
  };
  frontendServiceStackList.push(frontendStageConfigurationList);

  /*
   --- Back End Stacks ---
   */
  // VPC Stack
  const backendVpcStackProps: VpcStackProps = {
    stageName: stageConfig.stage,
  };
  const backendVpcStackName: string = createVpcStackName(stageConfig.stage, stageConfig.region, BACK_END);
  new VpcStack(app, backendVpcStackName, backendVpcStackProps);

  // ECS Service Stack
  const backendApplicationStackProps: ApplicationStackProps = {
    stageName: stageConfig.stage,
  };
  const serviceStackName: string = createServiceStackName(stageConfig.stage, stageConfig.region);
  new ApplicationStack(app, serviceStackName, backendApplicationStackProps);

  const backendStageConfigurationList: ApplicationStackConfigInterface = {
    config: stageConfig,
  };
  // Adds different stacks for Beta vs Prod environments
  backendServiceStackList.push(backendStageConfigurationList);
}

// Frontend Pipeline
const frontEndPipelineStackProps: FrontendPipelineStackProps = {
  stacksToDeploy: frontendServiceStackList,
  env: {
    region: 'us-west-2',
    account: process.env.CDK_DEFAULT_ACCOUNT || stageConfigurationList[0].accountId,
  },
};
new FrontendPipelineStack(app, FrontendPipelineStackName, frontEndPipelineStackProps);

// Website Pipeline
// Note: This will only work after you've deployed the website bucket stacks first
const websitePipelineStackProps: WebsitePipelineStackProps = {
  stacksToDeploy: websiteServiceStackList,
  env: {
    region: 'us-west-2',
    account: process.env.CDK_DEFAULT_ACCOUNT || stageConfigurationList[0].accountId,
  },
};
new WebsitePipelineStack(app, WebsitePipelineStackName, websitePipelineStackProps);

// Backend Pipeline
const backendPipelineStackProps: BackendPipelineStackProps = {
  stacksToDeploy: backendServiceStackList,
};
new BackendPipelineStack(app, BackendPipelineStackName, backendPipelineStackProps);

app.synth();
