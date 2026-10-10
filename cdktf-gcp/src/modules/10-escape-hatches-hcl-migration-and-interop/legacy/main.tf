# Legacy HCL managed by another team. The CDKTF equivalent is ../converted.ts.
#
# Hand this file to `cdktf convert`:
#   cdktf convert --language typescript --provider "hashicorp/google@~> 6.0" < legacy/main.tf > converted.generated.ts
# and compare with converted.ts (see README: what convert gets right and wrong).

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  backend "gcs" {
    bucket = "cdkm-tf-state"
    prefix = "legacy/assets"
  }
}

variable "project_id" {
  type        = string
  description = "Project that owns the legacy assets bucket"
}

variable "environment" {
  type    = string
  default = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod"
  }
}

locals {
  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

provider "google" {
  project = var.project_id
  region  = "us-central1"
}

resource "google_storage_bucket" "assets" {
  name                        = "cdkm-legacy-assets-${var.environment}"
  location                    = "US"
  uniform_bucket_level_access = true
  labels                      = local.labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_service_account" "assets_reader" {
  account_id   = "legacy-assets-reader"
  display_name = "Legacy assets reader"
}

resource "google_storage_bucket_iam_member" "reader" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.assets_reader.email}"
}

output "assets_bucket" {
  value       = google_storage_bucket.assets.name
  description = "Consumed by newer stacks through terraform_remote_state"
}

output "reader_email" {
  value = google_service_account.assets_reader.email
}
