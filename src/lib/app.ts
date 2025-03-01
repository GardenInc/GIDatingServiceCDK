#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from './stacks/backend/applicationStack';
import { BackendPipelineStack, BackendPipelineStackProps } from './stacks/backend/backendPipelineStack';
import { FrontendPipelineStackProps, FrontendPipelineStack } from './stacks/frontend/frontendPipelineStack';
import { DeviceFarmStackProps, DeviceFarmStack } from './stacks/frontend/deviceFarmStack';
import { stageConfigurationList } from './utils/config';
import {
  FrontEndStackConfigInterface,
  ApplicationStackConfigInterface,
  StacksInterface,
  PropsInterface,
  FrontEndStacksInterface,
  FrontEndPropsInterface,
} from './utils/config';
import { ApplicationStackProps } from './stacks/backend/applicationStack';
import { VpcStackProps, VpcStack } from './stacks/backend/vpcStack';
import { BackendPipelineStackName, FrontendPipelineStackName, FRONT_END, BACK_END } from './utils/constants';
import {
  createServiceStackName,
  createVpcStackName,
  createDeviceFarmStackName,
  createDeploymentBucketStackName,
} from './utils/utils';
import { DeploymentBucketStackProps, DeploymentBucketStack } from './stacks/frontend/deploymentBucketStack';

const app = new cdk.App();

// Setup a stack of applications which will be deployed to the pipeline
const backendServiceStackList: ApplicationStackConfigInterface[] = [];
const frontendServiceStackList: FrontEndStackConfigInterface[] = [];
for (var stageConfig of stageConfigurationList) {
  /*
   --- Front End Stacks ---
  */

  // Device Farm Stack

  // VPC Stack
  // Cluster Stack
  // EC2 Stack

  // VPC Stack
  const deviceFarmStackProps: DeviceFarmStackProps = {
    stageName: stageConfig.stage,
  };
  const deviceFarmStackName: string = createDeviceFarmStackName(stageConfig.stage, stageConfig.region, FRONT_END);
  const deviceFarmStack = new DeviceFarmStack(app, deviceFarmStackName, deviceFarmStackProps);

  const deploymentBucketStackProps: DeploymentBucketStackProps = {
    stageName: stageConfig.stage,
  };
  const deploymentBucketStackName: string = createDeploymentBucketStackName(
    stageConfig.stage,
    stageConfig.region,
    FRONT_END,
  );
  const deploymentBucketStack = new DeploymentBucketStack(app, deploymentBucketStackName, deploymentBucketStackProps);

  // Add new stacks to the following packages
  const frontendStacksInterface: FrontEndStacksInterface = {
    deploymentBucketStack: deploymentBucketStack,
    deviceFarmStack: deviceFarmStack,
  };
  const frontendPropsInterface: FrontEndPropsInterface = {
    deploymentBucketStackProps: deploymentBucketStackProps,
    deviceFarmStackProps: deviceFarmStackProps,
  };

  const frontendStageConfigurationList: FrontEndStackConfigInterface = {
    props: frontendPropsInterface,
    stacks: frontendStacksInterface,
    config: stageConfig,
    deploymentBucket: deploymentBucketStack.appBucket,
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
  const backendVpcStack = new VpcStack(app, backendVpcStackName, backendVpcStackProps);

  // ECS Service Stack
  const backendApplicationStackProps: ApplicationStackProps = {
    stageName: stageConfig.stage,
  };
  const serviceStackName: string = createServiceStackName(stageConfig.stage, stageConfig.region);
  const backendServiceStack = new ApplicationStack(app, serviceStackName, backendApplicationStackProps);

  // Add new stacks to the following packages
  const backendStacksInterface: StacksInterface = {
    applicationStack: backendServiceStack,
    vpcStack: backendVpcStack,
  };
  const backendPropsInterface: PropsInterface = {
    applicationStackProps: backendApplicationStackProps,
    vpcStackProps: backendVpcStackProps,
  };

  const backendStageConfigurationList: ApplicationStackConfigInterface = {
    props: backendPropsInterface,
    stacks: backendStacksInterface,
    config: stageConfig,
  };

  // Adds different stacks for Beta vs Prod environments
  backendServiceStackList.push(backendStageConfigurationList);
}

// Frontend Pipeline
const frontEndPipelineStackProps: FrontendPipelineStackProps = {
  stacksToDeploy: frontendServiceStackList,
};
new FrontendPipelineStack(app, FrontendPipelineStackName, frontEndPipelineStackProps);

// Backend Pipeline
const backendPipelineStackProps: BackendPipelineStackProps = {
  stacksToDeploy: backendServiceStackList,
};
new BackendPipelineStack(app, BackendPipelineStackName, backendPipelineStackProps);

app.synth();
