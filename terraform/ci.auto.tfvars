# Non-secret deployment config. COMMITTED ON PURPOSE.
#
# terraform.tfvars holds the API keys and is gitignored, so CI never checks it
# out. Anything only written there silently reverts to its default on a deploy
# from main -- which is how production ended up sending flux-fill-pro an input
# it does not accept, and rejecting every composite.
#
# Nothing in this file is a secret. Keys stay in terraform.tfvars locally and
# in GitHub Actions secrets for CI. Terraform loads *.auto.tfvars
# automatically, in both places, so the two stop drifting.

# Which model renders the composite. An owner/name slug for an official hosted
# model, or a 64-hex hash for a pinned community model.
replicate_model_version = "black-forest-labs/flux-fill-pro"

# These travel WITH the line above -- change the model and you must revisit
# them. flux-fill-pro takes image + mask + prompt and nothing else, so the
# reference-image and negative-prompt fields are omitted by setting them
# empty. Replicate rejects a whole request containing any input the model does
# not declare.
#
# Note that with no reference field the model never sees the product photo, so
# the item is generated from its description rather than being the real
# catalogue item. See CLAUDE.md section 8.
backend_env = {
  REPLICATE_FIELD_NEGATIVE_PROMPT = ""
  REPLICATE_FIELD_REFERENCE       = ""

  # Spend cap on the unauthenticated /api/composite endpoint.
  RATE_LIMIT_MAX       = "20"
  RATE_LIMIT_WINDOW_MS = "3600000"
}
