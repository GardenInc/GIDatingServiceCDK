#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from './stacks/applicationStack';
import { PipelineStack, PipelineStackProps } from './stacks/pipelineStack';
import { stageConfigurationList } from './utils/config';
import { ApplicationStackConfigInterface, StacksInterface, PropsInterface } from './utils/config';
import { ApplicationStackProps } from './stacks/applicationStack';
import { VpcStackProps, VpcStack } from './stacks/vpcStack';
import { PipelineStackName } from './utils/constants';
import { createServiceStackName, createVpcStackName } from './utils/utils';

const app = new cdk.App();

// Setup a stack of applications which will be deployed to the pipeline
const serviceStackList: ApplicationStackConfigInterface[] = [];
for (var stageConfig of stageConfigurationList) {
  // VPC Stack
  const vpcStackProps: VpcStackProps = {
    stageName: stageConfig.stage,
  };
  const vpcStackName: string = createVpcStackName(stageConfig.stage, stageConfig.region);
  const vpcStack = new VpcStack(app, vpcStackName, vpcStackProps);

  // ECS Service Stack
  const applicationStackProps: ApplicationStackProps = {
    stageName: stageConfig.stage,
  };
  const serviceStackName: string = createServiceStackName(stageConfig.stage, stageConfig.region);
  const serviceStack = new ApplicationStack(app, serviceStackName, applicationStackProps);

  // Add new stacks to the following packages
  const stacksInterface: StacksInterface = {
    applicationStack: serviceStack,
    vpcStack: vpcStack,
  };
  const propsInterface: PropsInterface = {
    applicationStackProps: applicationStackProps,
    vpcStackProps: vpcStackProps,
  };

  const stageConfigurationList: ApplicationStackConfigInterface = {
    props: propsInterface,
    stacks: stacksInterface,
    config: stageConfig,
  };

  // Adds different stacks for Beta vs Prod environments
  serviceStackList.push(stageConfigurationList);
}

const pipelineStackProps: PipelineStackProps = {
  stacksToDeploy: serviceStackList,
};

new PipelineStack(app, PipelineStackName, pipelineStackProps);

app.synth();
