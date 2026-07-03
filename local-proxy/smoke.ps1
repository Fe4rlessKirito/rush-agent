param(
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [string]$OpenAiModel = "gpt-5-4",
    [string]$AnthropicModel = "claude-sonnet-4-6",
    [string]$SakanaModel = "sakana-namazu",
    [string]$FacebModel = "faceb-google/gemini-2.5-flash",
    [switch]$SkipProviderSmokes
)

$ErrorActionPreference = "Stop"

function Invoke-JsonPost {
    param(
        [string]$Url,
        [object]$Body
    )

    Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 20)
}

Write-Host "== Health ==" -ForegroundColor Cyan
Invoke-RestMethod "$BaseUrl/health" | ConvertTo-Json -Depth 10

Write-Host "== Models ==" -ForegroundColor Cyan
Invoke-RestMethod "$BaseUrl/v1/models" | ConvertTo-Json -Depth 10

$openaiSession = "smoke-openai"
$anthropicSession = "smoke-anthropic"

Write-Host "== OpenAI Text ==" -ForegroundColor Cyan
$openaiText = Invoke-JsonPost "$BaseUrl/v1/chat/completions" @{
    model = $OpenAiModel
    user = $openaiSession
    messages = @(
        @{ role = "user"; content = "Reply with the word OK." }
    )
}
$openaiText | ConvertTo-Json -Depth 20

Write-Host "== OpenAI File Payload ==" -ForegroundColor Cyan
$openaiFile = Invoke-JsonPost "$BaseUrl/v1/chat/completions" @{
    model = $OpenAiModel
    user = $openaiSession
    messages = @(
        @{
            role = "user"
            content = @(
                @{ type = "text"; text = "Read this file and say OK if you received it." },
                @{
                    type = "file"
                    file = @{
                        data = "data:text/plain;base64,$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('hello from smoke test')))"
                        filename = "smoke.txt"
                        media_type = "text/plain"
                    }
                }
            )
        }
    )
}
$openaiFile | ConvertTo-Json -Depth 20

Write-Host "== Anthropic Text ==" -ForegroundColor Cyan
$anthropicText = Invoke-JsonPost "$BaseUrl/v1/messages" @{
    model = $AnthropicModel
    metadata = @{ session_id = $anthropicSession }
    messages = @(
        @{
            role = "user"
            content = @(
                @{ type = "text"; text = "Reply with the word OK." }
            )
        }
    )
}
$anthropicText | ConvertTo-Json -Depth 20

Write-Host "== Anthropic File Payload ==" -ForegroundColor Cyan
$anthropicFile = Invoke-JsonPost "$BaseUrl/v1/messages" @{
    model = $AnthropicModel
    metadata = @{ session_id = $anthropicSession }
    messages = @(
        @{
            role = "user"
            content = @(
                @{ type = "text"; text = "Read this file and say OK if you received it." },
                @{
                    type = "file"
                    name = "smoke.txt"
                    source = @{
                        type = "base64"
                        media_type = "text/plain"
                        data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("hello from smoke test"))
                    }
                }
            )
        }
    )
}
$anthropicFile | ConvertTo-Json -Depth 20

if (-not $SkipProviderSmokes) {
    Write-Host "== Sakana Provider Text ==" -ForegroundColor Cyan
    $sakanaText = Invoke-JsonPost "$BaseUrl/v1/chat/completions" @{
        model = $SakanaModel
        user = "smoke-sakana"
        messages = @(
            @{ role = "user"; content = "Reply with the word OK." }
        )
    }
    $sakanaText | ConvertTo-Json -Depth 20

    Write-Host "== Faceb Provider Text ==" -ForegroundColor Cyan
    $facebText = Invoke-JsonPost "$BaseUrl/v1/chat/completions" @{
        model = $FacebModel
        user = "smoke-faceb"
        messages = @(
            @{ role = "user"; content = "Reply with the word OK." }
        )
    }
    $facebText | ConvertTo-Json -Depth 20

    Write-Host "== Faceb Provider Streaming ==" -ForegroundColor Cyan
    $facebStreamBody = @{
        model = $FacebModel
        user = "smoke-faceb-stream"
        stream = $true
        messages = @(
            @{ role = "user"; content = "Count from one to three." }
        )
    } | ConvertTo-Json -Depth 20
    $facebStreamBody | curl.exe -N -X POST "$BaseUrl/v1/chat/completions" -H "Content-Type: application/json" --data-binary '@-'
}

Write-Host "== Usage Overview ==" -ForegroundColor Cyan
Invoke-RestMethod "$BaseUrl/usage/overview" | ConvertTo-Json -Depth 20

Write-Host "== OpenAI Session Usage ==" -ForegroundColor Cyan
Invoke-RestMethod "$BaseUrl/usage/session/$openaiSession" | ConvertTo-Json -Depth 20

Write-Host "== Anthropic Session Usage ==" -ForegroundColor Cyan
Invoke-RestMethod "$BaseUrl/usage/session/$anthropicSession" | ConvertTo-Json -Depth 20
