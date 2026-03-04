# LeaseBase document-service

Document management — upload, download (presigned URLs), metadata, S3 storage.

## Stack

- **Runtime**: Node.js / NestJS (planned)
- **Container**: Docker -> ECS Fargate
- **Registry**: ECR `leasebase-{env}-v2-document-service`
- **Port**: 3000

## Infrastructure

Managed by Terraform in [leasebase-iac](https://github.com/motart/leasebase-iac).

## Getting Started

```bash
npm install
npm run start:dev
docker build -t leasebase-document-service .
npm test
```
