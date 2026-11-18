// file-share CI/CD — same shape as visit-counter / kimhwan-live:
//   GitHub push → Jenkins (build.kimhwan.com) → tests inside `docker build` → image → Docker Hub (akon47/file-share)
//   → ssh into the VM (10.10.10.225) → docker compose pull/up → smoke test.
pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    triggers {
        githubPush()
    }

    parameters {
        booleanParam(name: 'SKIP_DEPLOY', defaultValue: false, description: '빌드·푸시만 하고 배포는 건너뜀')
    }

    environment {
        IMAGE                 = 'akon47/file-share'
        TAG                   = "${env.BUILD_NUMBER}"
        GITHUB_CREDENTIALS_ID = 'git-hub'
        DOCKER_CREDENTIALS_ID = 'docker-hub'
        SSH_CREDENTIALS_ID    = 'file-share-deploy'
        DEPLOY_HOST           = 'deploy@10.10.10.225'
        DEPLOY_DIR            = '/srv/file-share'
        SSH_OPTS              = '-o StrictHostKeyChecking=no -o ConnectTimeout=15'
        BASE_URL              = 'http://10.10.10.225:8080'
    }

    stages {
        stage('Clone') {
            steps {
                git url: 'git@github.com:akon47/file-share.git', branch: 'main', credentialsId: GITHUB_CREDENTIALS_ID, changelog: true
            }
        }

        stage('Test') {
            steps {
                // Quality gates run in the image build (the snap Docker on this VM cannot bind-mount the workspace).
                sh 'docker build --pull --target test -t file-share-test:${TAG} .'
            }
            post {
                always {
                    sh 'docker rmi file-share-test:${TAG} >/dev/null 2>&1 || true'
                }
            }
        }

        stage('Build image') {
            steps {
                sh 'docker build --target runtime --build-arg APP_VERSION=${TAG} -t ${IMAGE}:${TAG} -t ${IMAGE}:latest .'
            }
        }

        stage('Push') {
            steps {
                withCredentials([usernamePassword(credentialsId: DOCKER_CREDENTIALS_ID, usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                    sh '''
                        echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin
                        docker push ${IMAGE}:${TAG}
                        docker push ${IMAGE}:latest
                        docker logout
                    '''
                }
            }
        }

        stage('Deploy') {
            when { expression { !params.SKIP_DEPLOY } }
            steps {
                sshagent(credentials: [SSH_CREDENTIALS_ID]) {
                    sh '''
                        ssh ${SSH_OPTS} ${DEPLOY_HOST} "mkdir -p ${DEPLOY_DIR}"
                        tar -C deploy -cf - . | ssh ${SSH_OPTS} ${DEPLOY_HOST} "tar -C ${DEPLOY_DIR} -xmf -"
                        ssh ${SSH_OPTS} ${DEPLOY_HOST} "cd ${DEPLOY_DIR} && chmod +x deploy.sh && APP_TAG=${TAG} ./deploy.sh"
                    '''
                }
            }
        }

        stage('Smoke test') {
            when { expression { !params.SKIP_DEPLOY } }
            steps {
                sh '''
                    body=$(curl -fsS --max-time 20 ${BASE_URL}/healthz)
                    echo "$body"
                    echo "$body" | grep -q "\\"version\\":\\"${TAG}\\"" || { echo "deployed version mismatch"; exit 1; }
                    curl -fsS --max-time 20 -o /dev/null ${BASE_URL}/
                    curl -fsS --max-time 20 -o /dev/null ${BASE_URL}/sw.js
                '''
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f >/dev/null 2>&1 || true'
        }
    }
}
