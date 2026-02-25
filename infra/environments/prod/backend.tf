terraform {
  backend "s3" {
    bucket         = "enbox-terraform-state"
    key            = "env/prod/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "enbox-terraform-locks"
    encrypt        = true
  }
}
