; Coserve CAD offline installer (Inno Setup 7). One setup exe carries the desktop app and every runtime; installing needs no network.
; Build: ISCC.exe /DAppVersion=<version> /DPayload=<dir> coserve-cad.iss, where <dir> holds app\, runtime\python\, runtime\calculix\, runtime\thermal\ and vc_redist.x64.exe.
; The wizard is a single page in the CoServe AI installer layout: brand, install button, optional install location, progress, launch.
#ifndef AppVersion
  #error Pass /DAppVersion=<version>
#endif
#ifndef Payload
  #error Pass /DPayload=<payload directory>
#endif
#define AppName "Coserve CAD"
#define AppExe "CoServe AI.exe"

[Setup]
AppId={{6F1C2A9E-3B7D-4E2A-9C41-8D5B0E7A1F32}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Coserve
; Python, CUDA and gmsh need a short ASCII path without spaces, so the default avoids Program Files and the user profile.
DefaultDirName={sd}\CoserveCAD
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=8
OutputBaseFilename=CoserveCAD-Setup-{#AppVersion}-x64
SetupIconFile=coserve-cad.ico
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\app\{#AppExe}
WizardStyle=modern light windows11 hidebevels
WizardBackColor=#ffffff
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Types]
Name: "full"; Description: "完整安装"
Name: "custom"; Description: "自定义安装"; Flags: iscustom

[Components]
Name: "main"; Description: "Coserve CAD 应用、CadFlow 内核、参数化编辑器、结构仿真（CalculiX）"; Types: full custom; Flags: fixed
Name: "thermal"; Description: "热仿真（ThermoForge 与 CUDA 运行库；没有 NVIDIA 显卡时使用 CPU）"; Types: full

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"

[Dirs]
; The app keeps sessions, settings and its project-folder choice under app\, so the signed-in user must be able to write the install directory.
Name: "{app}"; Permissions: users-modify

[InstallDelete]
; Upgrades replace the program trees wholesale; app\data is kept.
Type: filesandordirs; Name: "{app}\app\resources"
Type: filesandordirs; Name: "{app}\app\locales"
Type: filesandordirs; Name: "{app}\runtime"

[Files]
Source: "brand-2x.png"; Flags: dontcopy
Source: "button-install.png"; Flags: dontcopy
Source: "button-finish.png"; Flags: dontcopy
Source: "{#Payload}\app\*"; DestDir: "{app}\app"; Components: main; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\runtime\python\*"; DestDir: "{app}\runtime\python"; Components: main; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\runtime\calculix\*"; DestDir: "{app}\runtime\calculix"; Components: main; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\runtime\thermal\*"; DestDir: "{app}\runtime\thermal"; Components: thermal; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: VCRuntimeMissing

[Registry]
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\FileSystem"; ValueType: dword; ValueName: "LongPathsEnabled"; ValueData: 1

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\app\{#AppExe}"; WorkingDir: "{app}\app"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\app\{#AppExe}"; WorkingDir: "{app}\app"; Tasks: desktopicon

[UninstallDelete]
; Python caches, runtime state and the project-folder choice written after installation.
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\app\resources"
Type: files; Name: "{app}\app\coserve-projects"

[Code]
const
  // Layout in 96-DPI logical pixels of a 600 x 560 client area.
  PageWidth = 600;
  PageHeight = 560;
  TextColor = $15110F;
  MutedColor = $6B665F;
  ErrorColor = $2626DC;

var
  SetupFailure: String;
  Brand: TBitmapImage;
  InstallButton, FinishButton: TBitmapButton;
  ChangeLink, StatusText: TNewStaticText;
  DirInput: TNewEdit;
  DirBrowse: TNewButton;
  Progress: TNewProgressBar;
  LaunchCheck: TNewCheckBox;
  HomePage: TWizardPage;
  NextLeft: Integer;

function InstallSucceeded: Boolean;
begin
  Result := SetupFailure = '';
end;

// Python, gmsh and CUDA reject non-ASCII paths on some Windows code pages.
function AsciiPath(Dir: String): Boolean;
var
  I: Integer;
begin
  Result := Length(Dir) > 3;
  for I := 1 to Length(Dir) do
    if (Ord(Dir[I]) > 127) or (Dir[I] = ' ') then Result := False;
end;

// Returns '' when the install directory is usable, otherwise the reason shown to the user.
function DirError(Dir: String): String;
begin
  Result := '';
  if not (AsciiPath(Dir) and (Length(Dir) <= 40) and (Pos(':\', Dir) = 2)) then
    Result := '安装位置须为本地磁盘上的英文路径，不含空格、不是磁盘根目录，且不超过 40 个字符，例如 C:\CoserveCAD 或 D:\CoserveCAD。';
end;

procedure Place(Control: TControl; X, Y, W, H: Integer);
begin
  Control.SetBounds(ScaleX(X), ScaleY(Y), ScaleX(W), ScaleY(H));
end;

function MakeText(Caption: String; Y, Size: Integer; Color: TColor): TNewStaticText;
begin
  Result := TNewStaticText.Create(WizardForm);
  Result.Parent := WizardForm;
  Result.AutoSize := False;
  Result.WordWrap := True;
  Result.Alignment := taCenter;
  Result.Caption := Caption;
  Result.Font.Name := 'Microsoft YaHei UI';
  Result.Font.Size := Size;
  Result.Font.Color := Color;
  Place(Result, 48, Y, PageWidth - 96, 44);
end;

function ImageButton(FileName, Caption: String; Y: Integer): TBitmapButton;
begin
  ExtractTemporaryFile(FileName);
  Result := TBitmapButton.Create(WizardForm);
  Result.Parent := WizardForm;
  Result.Caption := Caption;
  Result.BackColor := clWhite;
  Result.Stretch := True;
  Result.PngImage.LoadFromFile(ExpandConstant('{tmp}\') + FileName);
  Result.Cursor := crHand;
  Place(Result, (PageWidth - 120) div 2, Y, 120, 44);
end;

procedure SetStatus(Message: String; Color: TColor);
begin
  StatusText.Font.Color := Color;
  StatusText.Caption := Message;
end;

procedure ShowDirInput(Sender: TObject);
begin
  ChangeLink.Visible := False;
  DirInput.Visible := True;
  DirBrowse.Visible := True;
  WizardForm.ActiveControl := DirInput;
end;

procedure BrowseDir(Sender: TObject);
var
  Dir: String;
begin
  Dir := DirInput.Text;
  if BrowseForFolder('选择安装位置', Dir, True) then DirInput.Text := Dir;
end;

procedure InstallClick(Sender: TObject);
var
  Error: String;
begin
  WizardForm.DirEdit.Text := RemoveBackslashUnlessRoot(Trim(DirInput.Text));
  Error := DirError(WizardForm.DirEdit.Text);
  if Error <> '' then begin
    SetStatus(Error, ErrorColor);
    Exit;
  end;
  WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

procedure FinishClick(Sender: TObject);
var
  Code: Integer;
begin
  if LaunchCheck.Visible and LaunchCheck.Checked then
    ExecAsOriginalUser(ExpandConstant('{app}\app\{#AppExe}'), '', ExpandConstant('{app}\app'), SW_SHOWNORMAL, ewNoWait, Code);
  WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

procedure InitializeWizard;
begin
  // The stock wizard chrome stays alive for page flow but is replaced by the controls below.
  WizardForm.OuterNotebook.Visible := False;
  WizardForm.Bevel.Visible := False;
  // Inno advances pages (silent installs, InstallClick) only through a visible Next button, so it is moved off-screen instead of hidden.
  NextLeft := WizardForm.NextButton.Left;
  WizardForm.NextButton.Left := -ScaleX(1000);
  WizardForm.BackButton.Visible := False;
  WizardForm.CancelButton.Visible := False;
  WizardForm.ClientWidth := ScaleX(PageWidth);
  WizardForm.ClientHeight := ScaleY(PageHeight);
  WizardForm.Caption := '安装 {#AppName}';
  HomePage := CreateCustomPage(wpWelcome, '', '');

  ExtractTemporaryFile('brand-2x.png');
  Brand := TBitmapImage.Create(WizardForm);
  Brand.Parent := WizardForm;
  Brand.BackColor := clWhite;
  Brand.Stretch := True;
  Brand.PngImage.LoadFromFile(ExpandConstant('{tmp}\brand-2x.png'));
  Place(Brand, 0, 120, PageWidth, 196);

  ChangeLink := MakeText('安装到 ' + WizardForm.DirEdit.Text + '　更改', 372, 9, MutedColor);
  ChangeLink.Cursor := crHand;
  ChangeLink.OnClick := @ShowDirInput;
  Place(ChangeLink, 48, 380, PageWidth - 96, 24);

  DirInput := TNewEdit.Create(WizardForm);
  DirInput.Parent := WizardForm;
  DirInput.Text := WizardForm.DirEdit.Text;
  DirInput.Font.Name := 'Microsoft YaHei UI';
  DirInput.Font.Size := 10;
  DirInput.Visible := False;
  Place(DirInput, 96, 374, 320, 30);
  DirBrowse := TNewButton.Create(WizardForm);
  DirBrowse.Parent := WizardForm;
  DirBrowse.Caption := '选择';
  DirBrowse.OnClick := @BrowseDir;
  DirBrowse.Visible := False;
  Place(DirBrowse, 424, 374, 80, 30);

  InstallButton := ImageButton('button-install.png', '立即安装', 424);
  InstallButton.OnClick := @InstallClick;

  Progress := TNewProgressBar.Create(WizardForm);
  Progress.Parent := WizardForm;
  Progress.Min := 0;
  Progress.Max := 1000;
  Progress.Visible := False;
  Place(Progress, 64, 436, PageWidth - 128, 6);

  LaunchCheck := TNewCheckBox.Create(WizardForm);
  LaunchCheck.Parent := WizardForm;
  LaunchCheck.Caption := '立即启动 {#AppName}';
  LaunchCheck.Checked := True;
  LaunchCheck.Font.Name := 'Microsoft YaHei UI';
  LaunchCheck.Font.Size := 9;
  LaunchCheck.Visible := False;
  Place(LaunchCheck, (PageWidth - 180) div 2, 380, 180, 24);

  FinishButton := ImageButton('button-finish.png', '完成', 424);
  FinishButton.OnClick := @FinishClick;
  FinishButton.Visible := False;

  StatusText := MakeText('', 482, 9, MutedColor);
  Place(StatusText, 48, 482, PageWidth - 96, 60);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Components and tasks keep their defaults (everything, with a desktop shortcut); /COMPONENTS and /TASKS still apply.
  Result := (PageID = wpSelectComponents) or (PageID = wpSelectTasks);
end;

procedure StockWizard(Visible: Boolean);
begin
  WizardForm.OuterNotebook.Visible := Visible;
  if Visible then WizardForm.NextButton.Left := NextLeft else WizardForm.NextButton.Left := -ScaleX(1000);
  WizardForm.CancelButton.Visible := Visible;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // The Preparing page (applications to close, or a refusal) has no custom equivalent, so it uses the stock wizard.
  StockWizard(CurPageID = wpPreparing);
  if CurPageID = wpInstalling then begin
    ChangeLink.Visible := False;
    DirInput.Visible := False;
    DirBrowse.Visible := False;
    InstallButton.Visible := False;
    Progress.Visible := True;
    SetStatus('正在安装文件… 0%', MutedColor);
  end else if CurPageID = wpFinished then begin
    Progress.Visible := False;
    FinishButton.Visible := True;
    if InstallSucceeded then begin
      LaunchCheck.Visible := True;
      SetStatus('安装完成。首次启动选择“使用 API Key”，填写 API Key 与 Base URL（内网模型网关地址，例如 http://10.0.0.8:8000）。', MutedColor);
    end else
      SetStatus(SetupFailure, ErrorColor);
    WizardForm.ActiveControl := FinishButton;
  end;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
begin
  if MaxProgress <= 0 then Exit;
  Progress.Position := CurProgress * 1000 div MaxProgress;
  StatusText.Caption := '正在安装文件… ' + IntToStr(CurProgress * 100 div MaxProgress) + '%';
end;

function VCRuntimeMissing: Boolean;
var
  Installed, Minor: Cardinal;
begin
  Result := not (RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) and (Installed = 1)
    and RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Minor', Minor) and (Minor >= 40));
end;

procedure Fail(Message: String);
begin
  SetupFailure := Message;
  Log(Message);
  SuppressibleMsgBox(Message, mbCriticalError, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  // 1638: a newer runtime is already present; 3010: installed, reboot pending.
  if FileExists(ExpandConstant('{tmp}\vc_redist.x64.exe')) then begin
    StatusText.Caption := '正在安装 Microsoft VC++ 运行库…';
    if not Exec(ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, Code) then
      Fail('无法运行 Microsoft VC++ 运行库安装程序：' + SysErrorMessage(Code))
    else if (Code <> 0) and (Code <> 1638) and (Code <> 3010) then
      Fail('Microsoft VC++ 运行库安装失败（退出码 ' + IntToStr(Code) + '）。请以管理员身份手动运行安装包中的 vc_redist.x64.exe 后再启动 Coserve CAD。');
  end;
end;

// Silent installs never click the install button, so /DIR= is checked here.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := DirError(RemoveBackslashUnlessRoot(WizardDirValue));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(ExpandConstant('{app}\app\data')) and not UninstallSilent then
    if MsgBox('是否同时删除对话会话与设置（' + ExpandConstant('{app}\app\data') + '）？选择“否”将保留它们。CAD 项目文件夹不会被删除。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{app}\app\data'), True, True, True);
end;
