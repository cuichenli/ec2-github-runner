const { EC2Client, TerminateInstancesCommand, waitUntilInstanceRunning, CreateLaunchTemplateCommand, CreateFleetCommand, DeleteLaunchTemplateCommand, DeleteFleetsCommand } = require('@aws-sdk/client-ec2');

const { v4 } = require("uuid")

const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  let userData;
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    userData =  [
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
    ];
  } else {
    userData = [
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
    ];
  }
  if (config.input.runAsUser) {
    userData.push(`chown -R ${config.input.runAsUser} .`);
  }
  if (config.input.runAsService) {
    userData.push(`./svc.sh install ${config.input.runAsUser || ''}`);
    userData.push('./svc.sh start');
  } else {
    userData.push(`${config.input.runAsUser ? `su ${config.input.runAsUser} -c` : ''} ./run.sh`);
  }
  return userData;
}

async function createLaunchTemplate(label, githubRegistrationToken) {
  const ec2 = new EC2Client();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const input = {
    LaunchTemplateName: v4(),
    LaunchTemplateData: {
      ImageId: config.input.ec2ImageId,
      UserData: Buffer.from(userData.join('\n')).toString('base64'),
      SecurityGroupIds: [config.input.securityGroupId],
      IamInstanceProfile: {
        Name: config.input.iamRoleName
      }
    },
  };

  const command = new CreateLaunchTemplateCommand(input)
  const result = await ec2.send(command);
  core.setOutput("template-id", result.LaunchTemplate?.LaunchTemplateId)
  console.log(result)
  return result.LaunchTemplate?.LaunchTemplateId
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new EC2Client();

  const templateId = await createLaunchTemplate(label, githubRegistrationToken)
  
  if (templateId === undefined) {
    throw new Error("failed to create launch template")
  }

  const instanceTypes = config.input.ec2InstanceType.split(",")
  const subnets = config.input.subnetId.split(",")

  const instancesOverrides = []
  
  instanceTypes.forEach(type => {
    subnets.forEach(subnet => {
      instancesOverrides.push({
        "InstanceType": type,
        "SubnetId": subnet
      })
    })
  })

  const input = {
    LaunchTemplateConfigs: [
      {
        LaunchTemplateSpecification: {
          LaunchTemplateId: templateId, // your launch template ID
          Version: "$Latest", // or a specific version
        },
        Overrides: instancesOverrides
      },
    ],
    SpotOptions: {
      AllocationStrategy: "price-capacity-optimized"
    },
    TargetCapacitySpecification: {
      TotalTargetCapacity: 1,
      DefaultTargetCapacityType: "spot",
    },
    Type: "instant", // launches immediately or fails
  };

  try {
    const command = new CreateFleetCommand(input)
    const result = await ec2.send(command);
    const ec2InstanceId = result.Instances[0].InstanceIds[0]
    core.setOutput("fleet-id", result.FleetId)
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function deleteFleet() {
  const fleetId = config.input.fleetId
  if (!fleetId) {
    core.info("do not have fleet id. not delete anything")
    return 
  }
  const command = new DeleteFleetsCommand({
    FleetIds: [fleetId]
  })
  const ec2 = new EC2Client()
  ec2.send(command)
  core.info("deleted ec2 fleet")
}

async function deleteLaunchTemplate() {
  const templateId = config.input.templateId
  if (!templateId) {
    core.info("do not have template id. not delete anything")
    return
  }
  const command = new DeleteLaunchTemplateCommand({
    LaunchTemplateId: templateId
  })
  const ec2 = new EC2Client();
  await ec2.send(command)
  core.info("delete launch template")
}

async function terminateEc2Instance() {
  const ec2 = new EC2Client();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.send(new TerminateInstancesCommand(params));
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);

    await deleteLaunchTemplate()
    await deleteFleet()
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new EC2Client();
  try {
    core.info(`Checking for instance ${ec2InstanceId} to be up and running`);
    await waitUntilInstanceRunning(
      {
        client: ec2,
        maxWaitTime: 300,
      },
      {
        Filters: [
          {
            Name: 'instance-id',
            Values: [ec2InstanceId],
          },
        ],
      },
    );

    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
