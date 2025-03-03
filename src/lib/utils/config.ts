import { betaAccountId, prodAccountId } from './accounts';
import { ApplicationStackProps, ApplicationStack } from '../stacks/backend/applicationStack';
import { VpcStackProps, VpcStack } from '../stacks/backend/vpcStack';
import { DeviceFarmStack, DeviceFarmStackProps } from '../stacks/frontend/deviceFarmStack';
import { DeploymentBucketStackProps, DeploymentBucketStack } from '../stacks/frontend/deploymentBucketStack';
import * as s3 from 'aws-cdk-lib/aws-s3';

export enum STAGES {
  BETA = 'Beta',
  PROD = 'Prod',
}

export const REGIONS = {
  US_WEST_2: 'us-west-2',
  US_EAST_1: 'us-east-1',
};

interface StageConfigInterface {
  accountId: string;
  stage: string;
  region: string;
  isProd: boolean;
}

export const stageConfigurationList: StageConfigInterface[] = [
  {
    accountId: betaAccountId,
    stage: STAGES.BETA,
    region: REGIONS.US_WEST_2,
    isProd: false,
  },
  {
    accountId: prodAccountId,
    stage: STAGES.PROD,
    region: REGIONS.US_WEST_2,
    isProd: true,
  },
];

export interface ApplicationStackConfigInterface {
  props: PropsInterface;
  stacks: StacksInterface;
  config: StageConfigInterface;
}

export interface StacksInterface {
  applicationStack: ApplicationStack;
  vpcStack: VpcStack;
}

export interface PropsInterface {
  applicationStackProps: ApplicationStackProps;
  vpcStackProps: VpcStackProps;
}

export interface FrontEndStackConfigInterface {
  props: FrontEndPropsInterface;
  stacks: FrontEndStacksInterface;
  config: StageConfigInterface;
}

export interface FrontEndStacksInterface {
  deploymentBucketStack: DeploymentBucketStack;
  deviceFarmStack: DeviceFarmStack;
}

export interface FrontEndPropsInterface {
  deploymentBucketStackProps: DeploymentBucketStackProps;
  deviceFarmStackProps: DeviceFarmStackProps;
}
