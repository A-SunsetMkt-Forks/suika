import { Editor } from '../editor/editor';
import { IBox, IPoint, IRect } from '../type.interface';
import { drawCircle, rotateInCanvas } from '../utils/canvas';
import {
  arr2point,
  getRectCenterPoint,
  getRectsBBox,
  isPointInCircle,
  isPointInRect,
  isRectContain,
  isRectIntersect,
} from '../utils/graphics';
import rafThrottle from '../utils/raf_throttle';
import { transformRotate } from '../utils/transform';
import { Ellipse } from './ellipse';
import { getFill, Graph } from './graph';
import { Rect } from './rect';

const DOUBLE_PI = Math.PI * 2;

/**
 * 图形树
 */
export class SceneGraph {
  children: Graph[] = [];
  selection: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;
  handle: { rotation: IPoint } | null = null;

  constructor(private editor: Editor) {}
  appendChild(element: Graph, idx?: number) {
    if (idx === undefined) {
      this.children.push(element);
    } else {
      this.children.splice(idx, 0, element);
    }
  }
  removeChild(element: Graph) {
    const idx = this.children.indexOf(element);
    if (idx !== -1) {
      this.children.splice(idx, 1);
    }
    return idx;
  }
  // 全局重渲染
  render = rafThrottle(() => {
    // 获取视口区域
    const {
      viewportManager,
      canvasElement: canvas,
      ctx,
      setting,
    } = this.editor;
    const viewport = viewportManager.getViewport();
    const zoom = this.editor.zoomManager.getZoom();
    const viewportBoxInScene = { // TODO: 考虑外扩一个 padding
      x: viewport.x,
      y: viewport.y,
      width: viewport.width / zoom,
      height: viewport.height / zoom,
    };

    const visibleElements: Graph[] = [];
    // 1. 找出视口下所有元素
    // 暂时都认为是矩形
    for (let i = 0, len = this.children.length; i < len; i++) {
      const shape = this.children[i];

      if (isRectIntersect(shape.getBBox(), viewportBoxInScene)) {
        visibleElements.push(shape);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 2. 清空画布，然后绘制所有可见元素
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制背景色
    ctx.save();
    ctx.fillStyle = setting.canvasBgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // 场景坐标转换为视口坐标
    ctx.scale(zoom, zoom);
    ctx.translate(-viewport.x, -viewport.y);

    for (let i = 0, len = visibleElements.length; i < len; i++) {
      const element = visibleElements[i];
      ctx.fillStyle = getFill(element);
      if (element instanceof Rect) {
        if (element.rotation) {
          const cx = element.x + element.width / 2;
          const cy = element.y + element.height / 2;
          ctx.save();
          rotateInCanvas(ctx, element.rotation, cx, cy);
        }
        ctx.fillRect(element.x, element.y, element.width, element.height);
        if (element.rotation) {
          ctx.restore();
        }
      } else if (element instanceof Ellipse) {
        const cx = element.x + element.width / 2;
        const cy = element.y + element.height / 2;

        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy,
          element.width / 2,
          element.height / 2,
          element.rotation || 0,
          0,
          DOUBLE_PI
        );
        ctx.fill();
        ctx.closePath();
      }
    }

    /******************* 绘制辅助线层 ********************/
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 3. 绘制 选中框
    this.highLightSelectedBox();

    // 绘制选区（使用选区工具时用到）
    if (this.selection) {
      ctx.save();
      ctx.strokeStyle = setting.selectionStroke;
      ctx.fillStyle = setting.selectionFill;
      const { x, y, width, height } = this.selection;

      const { x: xInViewport, y: yInViewport } =
        this.editor.sceneCoordsToViewport(x, y);

      const widthInViewport = width * zoom;
      const heightInViewport = height * zoom;

      ctx.fillRect(xInViewport, yInViewport, widthInViewport, heightInViewport);
      ctx.strokeRect(
        xInViewport,
        yInViewport,
        widthInViewport,
        heightInViewport
      );
      ctx.restore();
    }

    // 绘制 “旋转” 控制点
    const handle = (this.handle = this.getTransformHandle());
    if (handle) {
      ctx.save();
      ctx.strokeStyle = setting.handleRotationStroke;
      ctx.fillStyle = setting.handleRotationFill;
      ctx.lineWidth = setting.handleRotationStrokeWidth;

      const { x: xInViewport, y: yInViewport } =
        this.editor.sceneCoordsToViewport(handle.rotation.x, handle.rotation.y);
      drawCircle(ctx, xInViewport, yInViewport, setting.handleRotationRadius);
      ctx.restore();
    }

    // 绘制标尺
    this.editor.ruler.draw();

    ctx.restore();
  });
  /**
   * 光标是否落在旋转控制点上
   */
  isInRotationHandle(point: IPoint) {
    if (!this.handle) {
      return false;
    }
    // 计算旋转后的 x 和 y
    const rotationPoint = this.handle.rotation;
    const zoom = this.editor.zoomManager.getZoom();

    return isPointInCircle(point, {
      x: rotationPoint.x,
      y: rotationPoint.y,
      radius: this.editor.setting.handleRotationRadius / zoom,
    });
  }
  private highLightSelectedBox() {
    // 1. 计算选中盒
    const selectedElements = this.editor.selectedElements.getItems();
    if (selectedElements.length === 0) {
      return;
    }
    const bBoxes = selectedElements.map((element) =>
      element.getBBoxWithoutRotation()
    );

    const zoom = this.editor.zoomManager.getZoom();
    const ctx = this.editor.ctx;

    ctx.save();
    // 高亮元素轮廓
    for (let i = 0, len = bBoxes.length; i < len; i++) {
      ctx.save();
      const bBox = bBoxes[i];
      ctx.strokeStyle = this.editor.setting.guideBBoxStroke;

      const currElement = selectedElements[i];
      if (currElement.rotation) {
        const [cx, cy] = getRectCenterPoint(bBox);
        const { x: cxInViewport, y: cyInViewport } =
          this.editor.sceneCoordsToViewport(cx, cy);
        rotateInCanvas(ctx, currElement.rotation, cxInViewport, cyInViewport);
      }
      const { x: xInViewport, y: yInViewport } =
        this.editor.sceneCoordsToViewport(bBox.x, bBox.y);
      ctx.strokeRect(
        xInViewport,
        yInViewport,
        bBox.width * zoom,
        bBox.height * zoom
      );
      ctx.restore();
    }

    // 只有单个选中元素，不绘制选中盒
    // 多个选中元素时，才绘制选中盒
    if (selectedElements.length > 1) {
      const bBoxesWithRotation = selectedElements.map((element) =>
        element.getBBox()
      );
      const composedBBox = getRectsBBox(...bBoxesWithRotation);
      // 2. 高亮选中盒
      ctx.strokeStyle = this.editor.setting.guideBBoxStroke;
      const { x: xInViewport, y: yInViewport } =
        this.editor.sceneCoordsToViewport(composedBBox.x, composedBBox.y);
      ctx.strokeRect(
        xInViewport,
        yInViewport,
        composedBBox.width * zoom,
        composedBBox.height * zoom
      );
    }
    ctx.restore();
  }
  /**
   * 点是否在选中框（selectedBox）中
   */
  isPointInSelectedBox(point: IPoint) {
    const selectedElements = this.editor.selectedElements.getItems();
    if (selectedElements.length === 0) {
      return false;
    }

    let bBoxes: IBox[];
    // 【单个元素被选中】求不考虑旋转的 bBox，将其和旋转后的角度比较
    if (selectedElements.length === 1) {
      bBoxes = selectedElements.map((element) =>
        element.getBBoxWithoutRotation()
      );
      // 单个元素，要考虑旋转
      const element = selectedElements[0];
      const [cx, cy] = getRectCenterPoint(element);
      if (element.rotation) {
        point = arr2point(
          transformRotate(point.x, point.y, -element.rotation, cx, cy)
        );
      }
    }
    // 【多个元素被选中】
    else {
      bBoxes = selectedElements.map((element) => element.getBBox());
    }
    const composedBBox = getRectsBBox(...bBoxes);
    return isPointInRect(point, composedBBox);
  }
  getTopHitElement(hitPointer: IPoint): Rect | null {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const element: Rect = this.children[i];
      const bBox = element.getBBoxWithoutRotation();

      // "点击点" 根据图形进行 反旋转旋转
      const [cx, cy] = getRectCenterPoint(bBox);
      const rotatedHitPointer = element.rotation
        ? arr2point(
          transformRotate(
            hitPointer.x,
            hitPointer.y,
            -element.rotation,
            cx,
            cy
          )
        )
        : hitPointer;

      if (isPointInRect(rotatedHitPointer, bBox)) {
        return element;
      }
    }
    return null;
  }
  setSelection(partialRect: Partial<IRect>) {
    this.selection = Object.assign({}, this.selection, partialRect);
  }
  getElementsInSelection() {
    const selection = this.selection;
    if (selection === null) {
      console.warn('selection 为 null，请确认在正确的时机调用当前方法');
      return [];
    }

    const elements = this.children;
    const containedElements: Graph[] = [];
    for (let i = 0, len = elements.length; i < len; i++) {
      if (isRectContain(selection, elements[i].getBBox())) {
        containedElements.push(elements[i]);
      }
    }
    return containedElements;
  }
  getTransformHandle() {
    /**
     * rotation: 旋转方向为正北方向
     * ne 东北（西：west、北：north、东：east、西：west）
     * nw 西北
     * sw 西南 south west（左下）
     * se
     */
    // 1. 先考虑 “单个元素” 的 “旋转” 控制点
    const selectedElements = this.editor.selectedElements.getItems();
    const zoom = this.editor.zoomManager.getZoom();

    if (selectedElements.length === 0) {
      return null;
    }
    if (selectedElements.length === 1) {
      const singleSelectElement = selectedElements[0];
      const { x, y, width } = singleSelectElement.getBBoxWithoutRotation();
      // 旋转位置
      let rotation = {
        x: x + width / 2,
        y: y - 14 / zoom,
      };
      const [cx, cy] = this.editor.selectedElements.getCenterPoint();
      if (singleSelectElement.rotation) {
        rotation = arr2point(
          transformRotate(
            rotation.x,
            rotation.y,
            singleSelectElement.rotation,
            cx,
            cy
          )
        );
      }
      return {
        rotation,
      };
    } else {
      return null;
    }
  }
}
