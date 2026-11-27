CAStudio 参数化建模模块

CAD 内核：官方 CadFlow 0.2.0 Windows wheel（resources/cadflow-wheel，MIT，含编译的 cadflow_core.dll 原生后端与 OCCT 7.9.3 运行库；原生 cad.Model() 与录制图 r-op 均可用）。
运行/编辑器层：castudio_runtime（resources/castudio-runtime，Apache-2.0，改编自 PhySpace/SimpleCADAPI 2.2.6.post2，提交 9e749ed706aa3e40cbf78b2dcfff5717737a0c2f；完整许可证与归属见该目录 LICENSE / THIRD_PARTY.txt）。

使用流程
1. 打开原 CAStudio 项目，进入“参数”工作区。
2. 首次使用可从模板创建参数化程序：圆柱壳（parametric/cylinder.py）、平板（parametric/plate.py，长、宽、厚与可选孔阵列）或空白程序（parametric/blank.py，长、宽、高参数与一个方块 `body`，供 Agent 改写为任意几何；只经 API 安装，面板不显示卡片）。所选模板和入口文件记录在 parametric/program.json；没有该记录的旧项目按圆柱壳处理。已有项目不会覆盖原 CadFlow 源码或结果。
3. 打开编辑器。左侧编辑建模步骤与参数，中间选择实体、面、边、顶点，右侧检查 CAD 属性与标签。
4. 点击“导出 CAD 并校验仿真边界”。发布前会刷新待保存的编辑，并核对源码和参数已落盘。发布不会关闭编辑器：服务器先冻结源码副本（exports/<运行编号>/source），构建只读该副本，并在构建后核对副本哈希；若编辑器在构建期间又保存了修改，发布记录标注 sourceChangedDuringBuild。平板与空白程序只把 notebook 的 `body` 导出为 STEP、STL、场景包与 <模板>.build.json（plate.build.json、blank.build.json），不做仿真边界检查，也不能送入结构仿真。
5. 检查三组边界的面积和实体等价性；通过后点击“送入现有结构仿真”。
6. 原结构分析界面中的静力、几何非线性、网格验证、云图和 Word 下载继续使用原流程。

安装环境
- 使用 Python 3.12 的短路径 venv（例如 D:/castudio-env/cad）。
- 安装 requirements.txt 中的依赖，再 pip install --no-deps resources/cadflow-wheel/cadflow-0.2.0-cp312-cp312-win_amd64.whl resources/castudio-runtime（编辑器 webui 已预构建，无需 npm）。
- .studio/parametric-runtime.json 设置 {"python":"<venv>/Scripts/python.exe"}。
- CAStudio 根目录执行 npm run build，并正常启动 CAStudio。

运行方式
- CAD 编辑器是 CAStudio 管理的内嵌模块，每个项目有独立的本机服务和 notebook 工作区。
- cadflow 使用独立 Python 环境；原 CadFlow 和 CalculiX 运行环境保持独立。
- 参数化源码保存在项目 parametric/；每次发布保存在 parametric/exports/<运行编号>/。
- 发布时使用当前有效参数（包括尚未提交到源码的滑块覆盖值），并保存 effective-parameters.json。
- 重建发布快照时，应对 source/cylinder.py 使用 effective-parameters.json 中的覆盖值：
  from castudio_runtime.runtime.runner import run_notebook
  result = run_notebook('source/cylinder.py', overrides=json.load(open('effective-parameters.json')))
- Stage 1：每次运行新建一个共享 GraphSession 并按依赖顺序重放全部单元格，单元格缓存关闭（每次发布/重建完整重跑）；代码结构保留缓存接口供后续恢复。
- 本地模块、notebook 和 SDK 版本进入依赖摘要。不能将缓存命中当成新的求解结果。

当前仿真适配范围
- 新编辑器可以编辑参数化 CAD；当前 CAStudio 壳分析适配器仍对应用户确认的 1000×500 mm 加筋圆柱。
- 固定端面、轴压端面、圆柱外表面分别标记为 interface.fixed_support、interface.axial_load、interface.external_pressure。
- 导出时用 CAD 内核检查边界面积，并用与参考实体的双向布尔差验证实体等价性；提交分析时再次独立复核 STEP。
- 不等价的新尺寸模型可以保存和查看，但不能直接套用原圆柱壳网格。界面会明确阻止；需另行建立对应尺寸的壳理想化。
- CAD 面到壳中面的映射沿用原模型的端部近似；不是将实体外表面直接当成壳中面。
- 材料仍为假设弹性材料。旧分析中的未收敛状态和报告结论不会被迁移过程改为通过。
- 对通过实体等价检查的圆柱，报告继续包含原 Blender 渲染图；渲染颜色不表示仿真结果。

Agent 接口
/api/projects/<id>/parametric/start
/api/projects/<id>/parametric/agent/snapshot
/api/projects/<id>/parametric/agent/cells
/api/projects/<id>/parametric/agent/cells/edit|insert|delete|run
/api/projects/<id>/parametric/agent/sdk
/api/projects/<id>/parametric/publish
已有内置 Agent 的编辑锁仍生效，发布 CAD 需要在编辑回合释放锁之后进行。

源码改动
- resources/cadflow-wheel：官方 CadFlow 0.2.0 Windows wheel（原生 cadflow_core 后端 + OCCT 7.9.3，MIT；构建补丁与脚本见该目录）。
- resources/castudio-runtime：改编自 SimpleCADAPI 的运行时/编辑器层（runtime、editor 含预构建 webui、params/product/scene/build 等 shim）。
- resources/parametric：圆柱 notebook、语义边界、实体等价检查及本机服务适配器。
- server/parametric.ts、server/semantic-bindings.ts：项目生命周期、产物发布、参数与边界复核。
- ParametricPanel：CAStudio 入口及仿真交接。
- structural_sim/semantic.py 与现有求解器小范围接入：检查语义边界并映射到既有壳区域，保留旧 STEP 指纹路径。
