import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";

export class NlbPrivateLinkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    //===================================================================
    // VPC
    //===================================================================
    // VPC A とサブネットの作成
    const vpcA = new ec2.Vpc(this, "VpcA", {
      createInternetGateway: true,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/24"),
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          cidrMask: 28,
          name: "compute",
          subnetType: ec2.SubnetType.PUBLIC
        }
      ],
      maxAzs: 1
    });

    // VPC B とサブネットの作成
    const vpcB = new ec2.Vpc(this, "VpcB", {
      createInternetGateway: true,
      ipAddresses: ec2.IpAddresses.cidr("192.168.0.0/24"),
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          cidrMask: 28,
          name: "compute",
          subnetType: ec2.SubnetType.PUBLIC
        }
      ],
      maxAzs: 1
    });


    //===================================================================
    // IAM Role
    //===================================================================
    // EC2 インスタンスに割り当てるロール
    const instanceRole = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
      ]
    });


    //===================================================================
    // Security Group
    //===================================================================
    // VPC A に作成するセキュリティグループ
    // EC インスタンス A にアタッチするセキュリティグループ
    const instanceSgA = new ec2.SecurityGroup(this, "InstanceSgA", {
      vpc: vpcA,
      allowAllOutbound: true
    });
    // VPC エンドポイントにアタッチするセキュリティグループ
    const vpceSg = new ec2.SecurityGroup(this, "VpceSg", {
      vpc: vpcA,
      allowAllOutbound: false
    });
    vpceSg.connections.allowFrom(instanceSgA, ec2.Port.tcp(80));

    // VPC B に作成するセキュリティグループ
    // Network Load Blancer にアタッチするセキュリティグループ
    const nlbSg = new ec2.SecurityGroup(this, "NlbSg", {
      vpc: vpcB,
      allowAllOutbound: false
    });
    // EC インスタンス B にアタッチするセキュリティグループ
    const instanceSgB = new ec2.SecurityGroup(this, "InstanceSgB", {
      vpc: vpcB,
      allowAllOutbound: true
    });
    nlbSg.addIngressRule(ec2.Peer.ipv4("10.0.0.0/24"), ec2.Port.tcp(80));
    nlbSg.connections.allowTo(instanceSgB, ec2.Port.tcp(80));
    instanceSgB.connections.allowFrom(nlbSg, ec2.Port.tcp(80));


    //===================================================================
    // EC2 Instance
    //===================================================================
    // VPC A に作成するEC2インスタンス
    const instanceA = new ec2.Instance(this, "InstanceA", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      machineImage: new ec2.GenericLinuxImage({"ap-northeast-1": "ami-02a405b3302affc24"}),
      vpc: vpcA,
      role: instanceRole,
      securityGroup: instanceSgA
    });

    // VPC B に作成するEC2インスタンス
    const userData = ec2.UserData.forLinux({shebang: '#!/bin/bash'});
    userData.addCommands(
      'dnf update -y',
      'dnf install httpd -y',
      'echo "hello private link" > /var/www/html/index.html',
      'systemctl start httpd',
      'systemctl enable httpd'
    )
    const instanceB = new ec2.Instance(this, "InstanceB", {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      machineImage: new ec2.GenericLinuxImage({"ap-northeast-1": "ami-02a405b3302affc24"}),
      vpc: vpcB,
      role: instanceRole,
      securityGroup: instanceSgB,
      userData: userData
    });


    //===================================================================
    // Network Load Blancer
    //===================================================================
    // enforceSecurityGroupInboundRulesOnPrivateLinkTraffic
    // true の場合は PrivateLink 経由の通信に対してもセキュリティグループを適用する
    // false の場合は PrivateLink 経由の通信に対してはセキュリティグループを適用しない
    const nlb = new elb.NetworkLoadBalancer(this, "NLB", {
      vpc: vpcB,
      securityGroups: [nlbSg],
      enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: true
    });


    //===================================================================
    // Target Group
    //===================================================================
    const tg = new elb.NetworkTargetGroup(this, "TargetGroup", {
      port: 80,
      targetType: elb.TargetType.INSTANCE,
      vpc: vpcB,
      healthCheck: {
        enabled: true,
        healthyHttpCodes: "200",
        path: "/",
        protocol: elb.Protocol.HTTP
      },
      targets: [
        new targets.InstanceIdTarget(instanceB.instanceId)
      ]
    });


    //===================================================================
    // Listener Rule
    //===================================================================
    new elb.NetworkListener(this, "Listener", {
      loadBalancer: nlb,
      port: 80,
      defaultAction: elb.NetworkListenerAction.forward([tg])
    });


    //===================================================================
    // VPC Endpoint Service
    //===================================================================
    const vpcesvc = new ec2.VpcEndpointService(this, "EndpointService", {
      vpcEndpointServiceLoadBalancers: [nlb],
      acceptanceRequired: false,
      contributorInsights: false
    });

    //===================================================================
    // VPC Endpoint
    //===================================================================
    vpcA.addInterfaceEndpoint("Endpoint", {
      service: new ec2.InterfaceVpcEndpointService(vpcesvc.vpcEndpointServiceName),
      securityGroups: [vpceSg]
    })
  }
}
