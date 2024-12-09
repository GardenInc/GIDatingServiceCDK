import { betaAccountId, prodAccountId } from './accounts';
import { ApplicationStackProps, ApplicationStack } from '../stacks/applicationStack';

export enum STAGES {
  BETA = 'beta',
  PROD = 'prod',
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
  props: ApplicationStackProps;
  stack: ApplicationStack;
  config: StageConfigInterface;
}
