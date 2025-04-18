import { betaAccountId, prodAccountId } from './accounts';
import { ApplicationStackProps, ApplicationStack } from '../stacks/backend/applicationStack';
import { VpcStackProps, VpcStack } from '../stacks/backend/vpcStack';
import { DeviceFarmStack, DeviceFarmStackProps } from '../stacks/frontend/deviceFarmStack';
import { DeploymentBucketStackProps, DeploymentBucketStack } from '../stacks/frontend/deploymentBucketStack';

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
  domainName?: string; // Added optional domainName property
}

export const stageConfigurationList: StageConfigInterface[] = [
  {
    accountId: betaAccountId,
    stage: STAGES.BETA,
    region: REGIONS.US_WEST_2,
    isProd: false,
    domainName: 'qandmedating.com', // Add domain name for Beta
  },
  {
    accountId: prodAccountId,
    stage: STAGES.PROD,
    region: REGIONS.US_WEST_2,
    isProd: true,
    domainName: 'qandmedating.com', // Add domain name for Prod
  },
];

// BACK END REF
export interface ApplicationStackConfigInterface {
  config: StageConfigInterface;
}

// FRONT END REF
export interface FrontEndStackConfigInterface {
  config: StageConfigInterface;
  frontEndCodeDeploymentBucketArn: string;
}

// WEBSITE END REF
export interface WebsiteStackConfigInterface {
  config: StageConfigInterface;
  websiteBucketArn: string;
  websiteBucketName: string;
  distributionId: string;
  distributionDomainName: string;
}
