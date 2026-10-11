import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // ---- Security Group del ALB ----
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB: acepta HTTP/HTTPS desde internet',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    // ---- Security Group de las EC2 ----
    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'EC2: solo acepta trafico del ALB',
    });
    instanceSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP desde el ALB');
  }
}