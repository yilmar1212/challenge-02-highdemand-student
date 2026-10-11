import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
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


        // ---- Rol IAM de las EC2 (minimo privilegio) ----
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // ---- User data: el script de ejemplo del reto ----
    const userData = ec2.UserData.custom(
      fs.readFileSync(path.join(__dirname, '../../application/user-data.sh'), 'utf8'),
    );

    // ---- Launch Template ----
    const launchTemplate = new ec2.LaunchTemplate(this, 'AppLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: instanceSg,
      role: instanceRole,
      userData,
      associatePublicIpAddress: true,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // ---- Auto Scaling Group ----
    const asg = new autoscaling.AutoScalingGroup(this, 'AppAsg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 2,
      maxCapacity: 6,
    });

        // ---- Application Load Balancer ----
    const alb = new elbv2.ApplicationLoadBalancer(this, 'AppAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      open: false, // el albSg ya abre 80 y 443, no dejes que CDK agregue otra regla
    });

    listener.addTargets('AppTargets', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

        // ---- Boss Fight: escalar hacia afuera si la CPU pasa de 60% ----
    asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
    });

    // ---- (Opcional) Alarma de CloudWatch para monitorear el evento ----
    const cpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      metric: cpuMetric,
      threshold: 60,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'CPU promedio del ASG mayor a 60%',
    });

    new cdk.CfnOutput(this, 'AlbUrl', {
      value: `http://${alb.loadBalancerDnsName}`,
    });
  }
}