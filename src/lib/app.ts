#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from './stacks/applicationStack';
import { PipelineStack, PipelineStackProps } from './stacks/pipelineStack';
import { stageConfigurationList } from './utils/config';
import { ApplicationStackConfigInterface } from './utils/config';
import { ApplicationStackProps } from './stacks/applicationStack';
import { PipelineStackName } from './utils/constants';
import { createServiceStackName } from './utils/utils';

const app = new cdk.App();

// Setup a stack of applications which will be deployed to the pipeline
const serviceStackList: ApplicationStackConfigInterface[] = [];
for (var stageConfig of stageConfigurationList) {
  const applicationStackProps: ApplicationStackProps = {
    stageName: stageConfig.stage,
  };

  const serviceStackName: string = createServiceStackName(stageConfig.stage, stageConfig.region);
  const serviceStack = new ApplicationStack(app, serviceStackName, applicationStackProps);

  // Add new Stacks that need to be deployed here and add them to the stack list here
  const stageConfigurationList: ApplicationStackConfigInterface = {
    props: applicationStackProps,
    stack: [serviceStack],
    config: stageConfig,
  };

  serviceStackList.push(stageConfigurationList);
}

const pipelineStackProps: PipelineStackProps = {
  applicationStackConfigs: serviceStackList,
};

new PipelineStack(app, PipelineStackName, pipelineStackProps);

app.synth();
