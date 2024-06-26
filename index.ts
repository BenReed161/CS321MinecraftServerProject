import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";

const config = new pulumi.Config();

const publicKeyPath = config.require("publicKeyPath");
const privateKeyPath = config.require("privateKeyPath");

const publicKey = fs.readFileSync(publicKeyPath).toString();
const privateKey = pulumi.secret(fs.readFileSync(privateKeyPath).toString());

const mcserverKeyPair = new aws.ec2.KeyPair("mcserver-keypair", {publicKey: publicKey});

const mcserverEC2size = config.get("mcserverEC2size") || "t3.medium";

// Get the AMI for debian 12 image based on your region.
// https://wiki.debian.org/Cloud/AmazonEC2Image/Bullseye
// https://www.pulumi.com/ai/answers/493Zc8Z25H1SddFvuge5UN/managing-debian-repositories-with-ansible-in-python
const debian_ami = aws.ec2.getAmi({
    owners: ["136693071363"], // Official owner id for debian
    filters: [{
        name: "name",
        values: ["debian-12-amd64-20231013-1532"], //amd64
    }],
    mostRecent: true,
});

//JVM maximum and mimimum memory pool RAM allocation, defaults to 3G of mem
const mcserverXMX = config.get("mcserverXMX") || "3072";
const mcserverXMS = config.get("mcserverXMS") || "3072";

//https://www.pulumi.com/ai/answers/oW1vyw8e4Xi8dFD9Q552Df/creating-ec2-instances-with-aws-networking
const securityGroup = new aws.ec2.SecurityGroup("mcserver-secgrp", {
  egress: [{
      fromPort: 0,
      toPort: 0,
      protocol: "-1", // -1 means all protocols
      cidrBlocks: ["0.0.0.0/0"], // Allow all outbound traffic
  }],
  ingress: [
      {
          fromPort: 22,
          toPort: 22,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
      },
      {
          fromPort: 25565,
          toPort: 25565,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
      },
  ],
});

const mcserverInstance = new aws.ec2.Instance("mcserver-instance", {
  ami: debian_ami.then(debian_ami => debian_ami.id),
  instanceType: mcserverEC2size,

  keyName: mcserverKeyPair.id,

  vpcSecurityGroupIds: [securityGroup.id],

  tags: {
      Name: "MinecraftServer",
  },

  associatePublicIpAddress: true,
});

//install python
const updatePythonCmd = new command.remote.Command("updatePythonCmd", {
    connection: {
        host: mcserverInstance.publicIp,
        port: 22,
        user: "admin",
        privateKey: privateKey,
    },
    create: `(sudo apt update || true)`,
});

//render the playbook
const renderPlaybookCmd = new command.local.Command("renderPlaybookCmd", {
    create: "cat playbook.yml | envsubst > playbook_rendered.yml"
});

//play the playbook
const playAnsiblePlaybookCmd = new command.local.Command("playAnsiblePlaybookCmd", {
    create: pulumi.interpolate`ANSIBLE_HOST_KEY_CHECKING=False ansible-playbook -u admin -i '${mcserverInstance.publicIp},' --private-key ${privateKeyPath} playbook_rendered.yml --extra-vars "xmx=${mcserverXMX} xms=${mcserverXMS}"`,
    }, {
    dependsOn: [
        renderPlaybookCmd,
        updatePythonCmd
    ],
});

export const publicIp = mcserverInstance.publicIp;
export const publicDns = mcserverInstance.publicDns;