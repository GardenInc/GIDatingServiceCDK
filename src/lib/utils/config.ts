import { betaAccountId, prodAccountId } from './accounts';
import { ApplicationStackProps, ApplicationStack } from '../stacks/applicationStack';
import { VpcStackProps, VpcStack } from '../stacks/vpcStack';
import { Stack } from 'aws-cdk-lib';

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
