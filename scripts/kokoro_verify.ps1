$cases = @(
  @{voice="af_heart"; text="Hello, this is a test of the voice system. How do I sound today?"},
  @{voice="bf_emma"; text="Good evening. This is a test of the British voice on the new server engine."},
  @{voice="am_fenrir"; text="Welcome back. Today we test the male voice, running entirely on the local server."}
)
$i = 0
foreach ($c in $cases) {
  $i++
  $body = (@{text=$c.text; voice=$c.voice; speed=1.0; device="auto"} | ConvertTo-Json)
  $out = Join-Path $env:TEMP ("knew" + $i + ".wav")
  try {
    Invoke-RestMethod -Uri http://127.0.0.1:8010/api/kokoro/synth -Method POST -Body $body -ContentType "application/json" -TimeoutSec 300 -OutFile $out
    Write-Output ($c.voice + " bytes=" + (Get-Item $out).Length)
  } catch {
    Write-Output ($c.voice + " FAILED: " + $_.Exception.Message)
  }
}
