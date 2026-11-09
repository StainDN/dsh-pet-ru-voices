<#
  Локальный синтез речи для dsh-pet через Windows SAPI (голоса, установленные в системе).
  Вызов из плагина:
    powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File tts.ps1 -TextFile <txt> -OutFile <wav>
  Пишет WAV (22 кГц, 16 бит, моно — формат SAPI по умолчанию), интернет не нужен.
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$Rate = 0,
  [string]$VoiceMatch = 'Russian'
)

$ErrorActionPreference = 'Stop'

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw 'empty text' }

$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices()
$picked = $null
for ($i = 0; $i -lt $voices.Count; $i++) {
  $description = $voices.Item($i).GetDescription()
  if ($description -match $VoiceMatch) { $picked = $voices.Item($i); break }
}
if ($null -ne $picked) { $voice.Voice = $picked }

$stream = New-Object -ComObject SAPI.SpFileStream
$stream.Open($OutFile, 3, $false)  # 3 = SSFMCreateForWrite
$voice.AudioOutputStream = $stream
$voice.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$voice.Volume = 100
try {
  $voice.Speak($text)
}
finally {
  $stream.Close()
}
