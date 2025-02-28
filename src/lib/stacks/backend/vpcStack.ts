import { StackProps, App, Stack } from 'aws-cdk-lib';
import { Vpc, SubnetType, IpAddresses } from 'aws-cdk-lib/aws-ec2';

export interface VpcStackProps extends StackProps {
  // deployment stage of the VPC
  readonly stageName: string;
}

export class VpcStack extends Stack {
  public readonly vpc: Vpc;

  constructor(app: App, id: string, props: VpcStackProps) {
    super(app, id, props);

    // Define a simple VPC
    this.vpc = new Vpc(this, 'GIDatingBackendVPC', {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
    });
    /*
    this.vpc = new Vpc(this, 'GIDatingBackendVPC', {
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 3, // Maximum number of Availability Zones to use
      natGateways: 1, // Number of NAT Gateways
      subnetConfiguration: [
        {
          subnetType: SubnetType.PUBLIC,
          name: 'PublicSubnet',
          cidrMask: 24,
        },
        {
          subnetType: SubnetType.PRIVATE_ISOLATED,
          name: 'PrivateSubnet',
          cidrMask: 24,
        },
      ],
    });*/

    // create log group and enable logging
    // Add endpoints
  }
}
