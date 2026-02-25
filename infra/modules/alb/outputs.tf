output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer."
  value       = aws_lb.this.dns_name
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = aws_lb.this.arn
}

output "alb_zone_id" {
  description = "Canonical hosted zone ID of the ALB (for Route 53 alias records)."
  value       = aws_lb.this.zone_id
}

output "http_target_group_arn" {
  description = "ARN of the HTTP target group."
  value       = aws_lb_target_group.http.arn
}

output "ws_target_group_arn" {
  description = "ARN of the WebSocket target group."
  value       = aws_lb_target_group.ws.arn
}

output "alb_arn_suffix" {
  description = "ARN suffix of the ALB (for CloudWatch metric dimensions)."
  value       = aws_lb.this.arn_suffix
}
