$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

# Canonical vector geometry mirrors frontend/icons/icon-512.svg and
# electron/taskbar-icon.svg. Drawing it here keeps PNG/ICO generation
# dependency-free and reproducible on Windows build machines.
$root = Split-Path -Parent $PSScriptRoot
$designSize = 512.0
$compactOpticalScale = 1.12
$trayBadgeCenterX = 396.0
$trayBadgeCenterY = 123.0
$trayBadgeOuterDiameter = 160.0
$trayBadgeRingDiameter = 146.0
$trayBadgeFillDiameter = 124.0

$navy = [System.Drawing.ColorTranslator]::FromHtml("#06142e")
$outline = [System.Drawing.ColorTranslator]::FromHtml("#031027")
$violet = [System.Drawing.ColorTranslator]::FromHtml("#8b5cf6")
$orbitBlue = [System.Drawing.ColorTranslator]::FromHtml("#3b82f6")
$cyan = [System.Drawing.ColorTranslator]::FromHtml("#06b6ff")
$magenta = [System.Drawing.ColorTranslator]::FromHtml("#ff168f")
$white = [System.Drawing.ColorTranslator]::FromHtml("#f8fbff")
$recordingRed = [System.Drawing.ColorTranslator]::FromHtml("#ef4444")
$finalizingAmber = [System.Drawing.ColorTranslator]::FromHtml("#f59e0b")

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Bounds,
    [float]$Radius
  )

  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($Bounds.X, $Bounds.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Bounds.X, $Bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-OrbitBrush {
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.RectangleF]::new(0, 0, 512, 512),
    $violet,
    $cyan,
    90
  )
  $blend = [System.Drawing.Drawing2D.ColorBlend]::new(3)
  $blend.Colors = [System.Drawing.Color[]]@($violet, $orbitBlue, $cyan)
  $blend.Positions = [single[]]@(0.0, 0.52, 1.0)
  $brush.InterpolationColors = $blend
  return $brush
}

function New-RoutePath {
  param([switch]$Compact)

  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  if ($Compact) {
    $path.AddBezier(54, 414, 145, 405, 242, 355, 307, 261)
    $path.AddLine(307, 261, 321, 274)
    $path.AddBezier(321, 274, 254, 374, 164, 430, 68, 453)
  } else {
    $path.AddBezier(74, 418, 153, 405, 240, 356, 310, 257)
    $path.AddLine(310, 257, 318, 264)
    $path.AddBezier(318, 264, 251, 365, 169, 425, 86, 447)
  }
  $path.CloseFigure()
  return $path
}

function New-OwnshipPath {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $points = @(
    [System.Drawing.PointF]::new(312, 166),
    [System.Drawing.PointF]::new(358, 286),
    [System.Drawing.PointF]::new(312, 266),
    [System.Drawing.PointF]::new(266, 286)
  )
  $path.AddPolygon($points)
  return $path
}

function New-IconBitmap {
  param(
    [int]$Size,
    [switch]$Compact,
    [ValidateSet("none", "recording", "finalizing")]
    [string]$BadgeState = "none"
  )

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $bitmap.SetResolution(96, 96)

  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform([float]($Size / $designSize), [float]($Size / $designSize))

    if (-not $Compact) {
      $tile = New-RoundedRectanglePath `
        -Bounds ([System.Drawing.RectangleF]::new(4, 4, 504, 504)) `
        -Radius 108
      $tileBrush = [System.Drawing.SolidBrush]::new($navy)
      try {
        $graphics.FillPath($tileBrush, $tile)
      } finally {
        $tileBrush.Dispose()
        $tile.Dispose()
      }
    }

    $markState = $graphics.Save()
    try {
      if ($Compact) {
        $graphics.TranslateTransform(256, 256)
        $graphics.ScaleTransform([float]$compactOpticalScale, [float]$compactOpticalScale)
        $graphics.TranslateTransform(-256, -256)
      }

      $orbitBrush = New-OrbitBrush
      $arcWidth = if ($Compact) { 43 } else { 26 }
      $arcPen = [System.Drawing.Pen]::new($orbitBrush, $arcWidth)
      try {
        $arcPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $arcPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        if ($Compact) {
          $graphics.DrawArc($arcPen, 75, 75, 362, 362, 135, 180)
          $graphics.DrawArc($arcPen, 75, 75, 362, 362, 340, 95)
        } else {
          $graphics.DrawArc($arcPen, 86, 88, 340, 340, 145, 165)
          $graphics.DrawArc($arcPen, 86, 88, 340, 340, 346, 89)

          $innerPen = [System.Drawing.Pen]::new($orbitBrush, 24)
          try {
            $innerPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $innerPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $graphics.DrawArc($innerPen, 155, 165, 205, 205, 150, 155)
          } finally {
            $innerPen.Dispose()
          }
        }
      } finally {
        $arcPen.Dispose()
        $orbitBrush.Dispose()
      }

      $routePath = New-RoutePath -Compact:$Compact
      $routeBrush = [System.Drawing.SolidBrush]::new($magenta)
      $routePen = if ($Compact) { [System.Drawing.Pen]::new($magenta, 11) } else { $null }
      try {
        $graphics.FillPath($routeBrush, $routePath)
        if ($routePen) {
          $routePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
          $graphics.DrawPath($routePen, $routePath)
        }
      } finally {
        if ($routePen) { $routePen.Dispose() }
        $routeBrush.Dispose()
        $routePath.Dispose()
      }

      if (-not $Compact) {
        $waypointBrush = [System.Drawing.SolidBrush]::new($navy)
        $waypointPen = [System.Drawing.Pen]::new($magenta, 8)
        try {
          $graphics.FillEllipse($waypointBrush, 391, 140, 30, 30)
          $graphics.DrawEllipse($waypointPen, 391, 140, 30, 30)
        } finally {
          $waypointBrush.Dispose()
          $waypointPen.Dispose()
        }
      }

      $ownshipPath = New-OwnshipPath
      $ownshipBrush = [System.Drawing.SolidBrush]::new($white)
      $outlineWidth = if ($Compact) { 12 } else { 6 }
      $ownshipPen = [System.Drawing.Pen]::new($outline, $outlineWidth)
      $ownshipPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      $state = $graphics.Save()
      try {
        $graphics.TranslateTransform(312, 250)
        $graphics.RotateTransform(45)
        if ($Compact) { $graphics.ScaleTransform(1.18, 1.18) }
        $graphics.TranslateTransform(-312, -250)
        $graphics.FillPath($ownshipBrush, $ownshipPath)
        $graphics.DrawPath($ownshipPen, $ownshipPath)
      } finally {
        $graphics.Restore($state)
        $ownshipPen.Dispose()
        $ownshipBrush.Dispose()
        $ownshipPath.Dispose()
      }
    } finally {
      $graphics.Restore($markState)
    }

    if ($Compact -and $BadgeState -ne "none") {
      $badgeColor = if ($BadgeState -eq "finalizing") { $finalizingAmber } else { $recordingRed }
      $badgeOutlineBrush = [System.Drawing.SolidBrush]::new($outline)
      $badgeRingBrush = [System.Drawing.SolidBrush]::new($white)
      $badgeFillBrush = [System.Drawing.SolidBrush]::new($badgeColor)
      try {
        $outerBounds = [System.Drawing.RectangleF]::new(
          [single]($trayBadgeCenterX - ($trayBadgeOuterDiameter / 2)),
          [single]($trayBadgeCenterY - ($trayBadgeOuterDiameter / 2)),
          [single]$trayBadgeOuterDiameter,
          [single]$trayBadgeOuterDiameter
        )
        $ringBounds = [System.Drawing.RectangleF]::new(
          [single]($trayBadgeCenterX - ($trayBadgeRingDiameter / 2)),
          [single]($trayBadgeCenterY - ($trayBadgeRingDiameter / 2)),
          [single]$trayBadgeRingDiameter,
          [single]$trayBadgeRingDiameter
        )
        $fillBounds = [System.Drawing.RectangleF]::new(
          [single]($trayBadgeCenterX - ($trayBadgeFillDiameter / 2)),
          [single]($trayBadgeCenterY - ($trayBadgeFillDiameter / 2)),
          [single]$trayBadgeFillDiameter,
          [single]$trayBadgeFillDiameter
        )
        $graphics.FillEllipse($badgeOutlineBrush, $outerBounds)
        $graphics.FillEllipse($badgeRingBrush, $ringBounds)
        $graphics.FillEllipse($badgeFillBrush, $fillBounds)
      } finally {
        $badgeFillBrush.Dispose()
        $badgeRingBrush.Dispose()
        $badgeOutlineBrush.Dispose()
      }
    }
  } finally {
    $graphics.Dispose()
  }

  return $bitmap
}

function New-OverlayBadgeBitmap {
  param(
    [int]$Size,
    [System.Drawing.Color]$FillColor
  )

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $bitmap.SetResolution(96, 96)

  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $outlineBrush = [System.Drawing.SolidBrush]::new($outline)
    $ringBrush = [System.Drawing.SolidBrush]::new($white)
    $fillBrush = [System.Drawing.SolidBrush]::new($FillColor)
    try {
      $graphics.FillEllipse($outlineBrush, 1, 1, $Size - 2, $Size - 2)
      $graphics.FillEllipse($ringBrush, 3, 3, $Size - 6, $Size - 6)
      $graphics.FillEllipse($fillBrush, 6, 6, $Size - 12, $Size - 12)
    } finally {
      $fillBrush.Dispose()
      $ringBrush.Dispose()
      $outlineBrush.Dispose()
    }
  } finally {
    $graphics.Dispose()
  }

  return $bitmap
}

function New-ScaledBitmap {
  param(
    [System.Drawing.Image]$SourceImage,
    [int]$Size,
    [float]$PaddingRatio = 0
  )

  $bitmap = [System.Drawing.Bitmap]::new(
    $Size,
    $Size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $bitmap.SetResolution(96, 96)

  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $padding = [Math]::Max(0, [int][Math]::Round($Size * $PaddingRatio))
    $artSize = $Size - ($padding * 2)
    $graphics.DrawImage(
      $SourceImage,
      [System.Drawing.Rectangle]::new($padding, $padding, $artSize, $artSize),
      0,
      0,
      $SourceImage.Width,
      $SourceImage.Height,
      [System.Drawing.GraphicsUnit]::Pixel
    )
  } finally {
    $graphics.Dispose()
  }

  return $bitmap
}

function Save-Png {
  param(
    [System.Drawing.Image]$Image,
    [string]$OutputPath
  )

  $directory = Split-Path -Parent $OutputPath
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $Image.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Write-MultiResolutionIco {
  param(
    [System.Drawing.Image]$SourceImage,
    [int[]]$Sizes,
    [string]$OutputPath,
    [float]$PaddingRatio = 0,
    [switch]$RenderCompactDirect
  )

  $entries = [System.Collections.Generic.List[object]]::new()
  foreach ($size in $Sizes) {
    $bitmap = if ($RenderCompactDirect) {
      New-IconBitmap -Size $size -Compact
    } else {
      New-ScaledBitmap `
        -SourceImage $SourceImage `
        -Size $size `
        -PaddingRatio $PaddingRatio
    }
    $stream = [System.IO.MemoryStream]::new()
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $entries.Add([pscustomobject]@{
        Size = $size
        Bytes = $stream.ToArray()
      })
    } finally {
      $stream.Dispose()
      $bitmap.Dispose()
    }
  }

  $directory = Split-Path -Parent $OutputPath
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null

  $fileStream = [System.IO.File]::Open(
    $OutputPath,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write
  )
  $writer = [System.IO.BinaryWriter]::new($fileStream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$entries.Count)

    $offset = 6 + (16 * $entries.Count)
    foreach ($entry in $entries) {
      $dimension = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$entry.Bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $entry.Bytes.Length
    }

    foreach ($entry in $entries) {
      $writer.Write([byte[]]$entry.Bytes)
    }
  } finally {
    $writer.Dispose()
    $fileStream.Dispose()
  }
}

$primarySource = New-IconBitmap -Size 1024
$compactSource = New-IconBitmap -Size 1024 -Compact
$recordingCompactSource = New-IconBitmap -Size 256 -Compact -BadgeState "recording"
$finalizingCompactSource = New-IconBitmap -Size 256 -Compact -BadgeState "finalizing"
$recordingOverlay = New-OverlayBadgeBitmap -Size 32 -FillColor $recordingRed
$finalizingOverlay = New-OverlayBadgeBitmap -Size 32 -FillColor $finalizingAmber
try {
  Save-Png -Image $primarySource -OutputPath (Join-Path $root "ff-logo2.png")

  $primaryOutputs = @(
    @{ Size = 1024; Path = Join-Path $root "electron/icon.png" },
    @{ Size = 512; Path = Join-Path $root "frontend/assets/app-icon.png" },
    @{ Size = 256; Path = Join-Path $root "electron/launcher/icon.png" }
  )

  foreach ($output in $primaryOutputs) {
    $bitmap = New-ScaledBitmap -SourceImage $primarySource -Size $output.Size
    try {
      Save-Png -Image $bitmap -OutputPath $output.Path
    } finally {
      $bitmap.Dispose()
    }
  }

  Write-MultiResolutionIco `
    -SourceImage $primarySource `
    -Sizes @(16, 20, 24, 32, 40, 48, 64, 128, 256) `
    -OutputPath (Join-Path $root "electron/icon.ico") `
    -PaddingRatio 0.04

  $taskbarPng = New-IconBitmap -Size 256 -Compact
  try {
    Save-Png -Image $taskbarPng -OutputPath (Join-Path $root "electron/taskbar-icon.png")
  } finally {
    $taskbarPng.Dispose()
  }

  Write-MultiResolutionIco `
    -SourceImage $compactSource `
    -Sizes @(16, 20, 24, 32, 40, 48, 64, 128, 256) `
    -OutputPath (Join-Path $root "electron/taskbar-icon.ico") `
    -RenderCompactDirect

  $badgeOutputs = @(
    @{ Source = $recordingCompactSource; Path = Join-Path $root "electron/taskbar-recording-icon.png" },
    @{ Source = $finalizingCompactSource; Path = Join-Path $root "electron/taskbar-finalizing-icon.png" },
    @{ Source = $recordingOverlay; Path = Join-Path $root "electron/recording-overlay.png" },
    @{ Source = $finalizingOverlay; Path = Join-Path $root "electron/finalizing-overlay.png" }
  )

  foreach ($output in $badgeOutputs) {
    $size = if ($output.Source.Width -eq 32) { 32 } else { 256 }
    $bitmap = New-ScaledBitmap -SourceImage $output.Source -Size $size
    try {
      Save-Png -Image $bitmap -OutputPath $output.Path
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $finalizingOverlay.Dispose()
  $recordingOverlay.Dispose()
  $finalizingCompactSource.Dispose()
  $recordingCompactSource.Dispose()
  $compactSource.Dispose()
  $primarySource.Dispose()
}

Write-Host "Generated Flight Fabric primary and compact icon sets"
