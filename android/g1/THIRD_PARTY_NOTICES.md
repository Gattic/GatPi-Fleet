# Third-party notices

## EvenDemoApp (Even Realities)

Source: https://github.com/even-realities/EvenDemoApp

This app re-implements, in Kotlin, the G1 Bluetooth protocol and connection
flow published in EvenDemoApp: the Nordic UART service and characteristic
UUIDs, the arm naming scheme, the connection setup order (services,
notifications, MTU 251, bond, `f4 01`), the 0x25 heartbeat, the 0x4E text
packet layout and paging rules, the 0x18 exit command and the 0xF5 touch event
codes. No GPL-licensed code or documentation was used.

```text
BSD 2-Clause License

Copyright (c) 2024, even-realities

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## even-g1-companion (Cheddies1)

Source: https://github.com/Cheddies1/even-g1-companion (BSD-2-Clause)

The meanings of the glasses' 0xF5 status codes, Silent Mode, the 0x21
QuickNote list and the 0x4E completion acknowledgement were taken as facts
from its protocol notes; no code was copied.

## Libraries (Apache License 2.0)

Bundled in the APK under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0):

- AndroidX Core (`androidx.core:core`), The Android Open Source Project
- kotlinx.coroutines (`org.jetbrains.kotlinx:kotlinx-coroutines-android`), JetBrains
- OkHttp and Okio (`com.squareup.okhttp3:okhttp`), Square, Inc.
