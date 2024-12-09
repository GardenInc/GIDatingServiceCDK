#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from './stacks/applicationStack';
import { PipelineStack, PipelineStackProps } from './stacks/pipelineStack';
import { stageConfigurationList } from './utils/config';
import { ApplicationStackConfigInterface } from './utils/config';
import { ApplicationStackProps } from './stacks/applicationStack';

const app = new cdk.App();

// Setup a stack of applications which will be deployed to the pipeline
const serviceStackList: ApplicationStackConfigInterface[] = [];
for (var stageConfig of stageConfigurationList) {
  const applicationStackProps: ApplicationStackProps = {
    stageName: stageConfig.stage,
  };
  // Setup service stack props
  // How are we going to manage multiple stacks here?
  const serviceStack = new ApplicationStack(
    app,
    `${stageConfig.stage}ServiceStack${stageConfig.region}`,
    applicationStackProps,
  );

  // Passing tuple to stack list with stack in first param / config for stack in second param
  const stageConfigurationList: ApplicationStackConfigInterface = {
    props: applicationStackProps,
    stack: serviceStack,
    config: stageConfig,
  };

  serviceStackList.push(stageConfigurationList);
}

const pipelineStackProps: PipelineStackProps = {
  applicationStackConfigs: serviceStackList,
};

new PipelineStack(app, 'CrossAccountPipelineDeploymentStack', pipelineStackProps);

app.synth();
